import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Limit, Snapshot } from '../types'

const snapshot = atom({ plugin: 'session-gauge', key: 'snapshot' } as const, null)
const now = atom({ plugin: 'session-gauge', key: 'now' } as const, 0)

/** How often the countdowns and the time markers move. */
const TICK_MS = 30_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** How long each window lasts, so the share of it already elapsed can be marked on its bar. */
const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * HOUR,
  seven_day: 7 * DAY,
  seven_day_opus: 7 * DAY,
  seven_day_sonnet: 7 * DAY,
}

const LABELS: Record<string, string> = {
  five_hour: 'Session',
  seven_day: 'Semaine',
  seven_day_opus: 'Opus',
  seven_day_sonnet: 'Sonnet',
  spend_limit: 'Plafond',
}

/** Windows listed first, in this order; any other follows as reported. */
const ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']

/** Cells between two gauges on the line. */
const GAP = 3
const MIN_BAR = 6
const MAX_BAR = 16

/**
 * What gives way first when the line runs short, lowest first: a detail with
 * no rank always stays, and past the last rank the gauges wrap.
 */
const DROP = { weeklyReset: 1, cost: 2, sessionReset: 3, compactHint: 4 }

/** The store key that remembers the legend was shown once. */
const LEGEND_SHOWN = 'legend-shown'
const LEGEND =
  'Session Gauge : sur chaque barre, le trait ┼ marque le temps écoulé dans la fenêtre. ' +
  'Une barre remplie au-delà du trait, c’est un rythme qui atteindra la limite avant le reset.'

const NBSP = ' '

type Segment = {
  text: string
  color?: Color
  dim?: boolean
  weight?: 'semibold'
  mono?: boolean
  tabular?: boolean
  /** A rank in DROP: the detail is left out when the line runs short. */
  drop?: number
}
type Bar = { share: number; color: Color; marker?: number }
type Gauge = { id: string; label: string; bar?: Bar; details: Segment[]; isAside?: boolean }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(TICK_MS, () => void tick($))
    await refresh($)

    if ((await $.store.get(LEGEND_SHOWN)) !== true) {
      $.ui.toast(LEGEND, { timeoutMs: 12_000 })
      await $.store.set(LEGEND_SHOWN, true)
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await refresh($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)

    if (e.props.hasSurvey || snap === null) {
      return next(e)
    }

    const t = Math.max(await read($, now), await $.clock.now())
    const { gauges, width } = fit(buildGauges(snap, t), e.props.bodyColumns)
    const { Box, Text } = $.ui.resolve(e)

    const runs = (segments: Segment[]) => segments.map(segment => <Text {...style(segment)}>{segment.text}</Text>)

    // Label, bar and figures are spaced by the layout, not by spaces in the
    // text: a surface may trim a run's trailing space, and `sm` is each
    // surface's own small step (one cell on the terminal).
    const view = (gauge: Gauge) => (
      <Box key={`gauge-${gauge.id}`} flexDirection="row" columnGap="sm">
        {gauge.label !== '' && <Text dimColor>{gauge.label}</Text>}
        {gauge.bar !== undefined && <Text>{runs(drawBar(width, gauge.bar))}</Text>}
        <Text>{runs(gauge.details)}</Text>
      </Box>
    )

    return (
      <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={GAP}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={GAP}>
          {gauges.filter(gauge => gauge.isAside !== true).map(view)}
        </Box>
        {gauges.filter(gauge => gauge.isAside === true).map(view)}
      </Box>
    )
  })
}

async function refresh($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  const at = await $.clock.now()
  await update($, snapshot, () => toSnapshot(usage))
  await update($, now, () => at)
}

async function tick($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
}

function toSnapshot(usage: SessionUsage): Snapshot {
  const limits = usage.rateLimits.map(limit => {
    const one: Limit = { kind: limit.kind, percentUsed: limit.percentUsed }
    const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
    if (Number.isFinite(resetsAt)) {
      one.resetsAt = resetsAt
    }
    return one
  })
  const snap: Snapshot = { limits, context: { window: usage.context.window }, startedAt: usage.startedAt }
  if (usage.context.tokens !== undefined) {
    snap.context.tokens = usage.context.tokens
  }
  if (usage.context.percent !== undefined) {
    snap.context.percent = usage.context.percent
  }
  if (usage.cost !== undefined) {
    snap.costUsd = usage.cost.usd
  }
  return snap
}

function buildGauges(snap: Snapshot, t: number): Gauge[] {
  const rank = (kind: string) => {
    const at = ORDER.indexOf(kind)
    return at === -1 ? ORDER.length : at
  }
  const limits = [...snap.limits].sort((a, b) => rank(a.kind) - rank(b.kind))
  const gauges = limits.map(limit => limitGauge(limit, t))

  if (gauges.length === 0) {
    gauges.push({ id: 'limits', label: 'Limites', details: [{ text: 'en attente', dim: true }] })
  }

  gauges.push(contextGauge(snap.context))

  if (snap.costUsd !== undefined) {
    gauges.push({
      id: 'cost',
      label: 'Coût',
      details: [{ text: `$${snap.costUsd.toFixed(2)}`, dim: true, tabular: true, drop: DROP.cost }],
      isAside: true,
    })
  }

  return gauges
}

/**
 * A rate-limit window: its bar filled to the share used, with a tick at the
 * share of the window already elapsed. Neutral while the pace holds; amber
 * once the pace runs out before the reset, which the gauge then says; red
 * from 90 %. A window whose reset has passed reads as a new one.
 */
function limitGauge(limit: Limit, t: number): Gauge {
  const label = LABELS[limit.kind] ?? limit.kind
  const isSession = limit.kind === 'five_hour'
  const emphasis = isSession ? { weight: 'semibold' as const } : {}

  if (limit.resetsAt !== undefined && limit.resetsAt <= t) {
    return {
      id: limit.kind,
      label,
      bar: { share: 0, color: 'text' },
      details: [
        { text: `0${NBSP}%`, tabular: true, ...emphasis },
        { text: ' · réinitialisée', dim: true },
      ],
    }
  }

  const used = limit.percentUsed
  const windowMs = WINDOW_MS[limit.kind]
  let elapsedShare: number | undefined
  let remainingMs: number | undefined
  let fullInMs: number | undefined

  if (limit.resetsAt !== undefined) {
    remainingMs = limit.resetsAt - t

    if (windowMs !== undefined) {
      const elapsedMs = Math.min(windowMs, Math.max(0, windowMs - remainingMs))
      elapsedShare = elapsedMs / windowMs

      if (used > 0 && used < 100 && elapsedMs >= windowMs * 0.05) {
        const eta = ((100 - used) * elapsedMs) / used
        if (eta < remainingMs) {
          fullInMs = eta
        }
      }
    }
  }

  const color: Color = used >= 90 ? 'error' : fullInMs !== undefined ? 'warning' : 'text'
  const bar: Bar = { share: used / 100, color }
  if (elapsedShare !== undefined) {
    bar.marker = elapsedShare
  }

  const details: Segment[] = [
    { text: percent(used), tabular: true, ...emphasis, ...(color !== 'text' && { color }) },
  ]

  if (remainingMs !== undefined) {
    details.push({
      text: ` · reset ${duration(remainingMs)}`,
      dim: true,
      tabular: true,
      drop: isSession ? DROP.sessionReset : DROP.weeklyReset,
    })
  }
  if (fullInMs !== undefined) {
    details.push({ text: ` ⚠ limite dans ~${duration(fullInMs)}`, color: 'warning' })
  }

  return { id: limit.kind, label, bar, details }
}

/** The context window: amber from 60 %, red from 85 %, where /compact is the way out. */
function contextGauge(context: Snapshot['context']): Gauge {
  const used = context.percent

  if (used === undefined) {
    return { id: 'context', label: 'Contexte', bar: { share: 0, color: 'text' }, details: [{ text: '–', dim: true }] }
  }

  const color: Color = used >= 85 ? 'error' : used >= 60 ? 'warning' : 'text'
  const details: Segment[] = [{ text: percent(used), tabular: true, ...(color !== 'text' && { color }) }]

  if (used >= 85) {
    details.push({ text: ' · /compact', color: 'error', drop: DROP.compactHint })
  }

  return { id: 'context', label: 'Contexte', bar: { share: used / 100, color }, details }
}

/**
 * Lays the gauges on one line: drops details by DROP rank until every bar
 * keeps at least MIN_BAR cells, then shares the room left among the bars.
 */
function fit(gauges: Gauge[], columns: number): { gauges: Gauge[]; width: number } {
  const ranks = [...new Set(gauges.flatMap(gauge => gauge.details.map(segment => segment.drop)))]
    .filter((rank): rank is number => rank !== undefined)
    .sort((a, b) => a - b)
  let laid = gauges

  for (const rank of [undefined, ...ranks]) {
    if (rank !== undefined) {
      laid = laid
        .map(gauge => ({ ...gauge, details: gauge.details.filter(segment => segment.drop !== rank) }))
        .filter(gauge => gauge.bar !== undefined || gauge.details.length > 0)
    }
    if (measure(laid) + bars(laid) * MIN_BAR <= columns) {
      break
    }
  }

  const room = bars(laid) === 0 ? 0 : Math.floor((columns - measure(laid)) / bars(laid))

  return { gauges: laid, width: Math.max(MIN_BAR, Math.min(MAX_BAR, room)) }
}

function bars(gauges: Gauge[]): number {
  return gauges.filter(gauge => gauge.bar !== undefined).length
}

/** The cells a line of these gauges takes besides their bars. */
function measure(gauges: Gauge[]): number {
  return gauges.reduce(
    (sum, gauge) =>
      sum +
      (gauge.label === '' ? 0 : gauge.label.length + 1) +
      (gauge.bar === undefined ? 0 : 1) +
      gauge.details.reduce((n, segment) => n + segment.text.length, 0),
    GAP * Math.max(0, gauges.length - 1),
  )
}

/** A thin line: heavy where used, light where left, crossed by a tick where the time is. */
function drawBar(width: number, bar: Bar): Segment[] {
  const filled = Math.min(width, Math.max(0, Math.round(bar.share * width)))
  const marker = bar.marker === undefined ? -1 : Math.min(width - 1, Math.floor(bar.marker * width))
  const cells: Segment[] = []

  for (let i = 0; i < width; i++) {
    if (i === marker) {
      cells.push({ text: i < filled ? '┿' : '┼', color: 'suggestion', mono: true })
    } else if (i < filled) {
      cells.push({ text: '━', color: bar.color, mono: true })
    } else {
      cells.push({ text: '─', dim: true, mono: true })
    }
  }

  return merge(cells)
}

/** Joins neighbouring cells of one style, so a bar is a few Texts and not one per cell. */
function merge(cells: Segment[]): Segment[] {
  const out: Segment[] = []

  for (const cell of cells) {
    const last = out[out.length - 1]
    if (last !== undefined && last.color === cell.color && last.dim === cell.dim) {
      last.text += cell.text
    } else {
      out.push({ ...cell })
    }
  }

  return out
}

function style(segment: Segment): {
  color?: Color
  dimColor?: boolean
  weight?: 'semibold'
  mono?: boolean
  tabular?: boolean
} {
  return {
    ...(segment.color !== undefined && { color: segment.color }),
    ...(segment.dim === true && { dimColor: true }),
    ...(segment.weight !== undefined && { weight: segment.weight }),
    ...(segment.mono === true && { mono: true }),
    ...(segment.tabular === true && { tabular: true }),
  }
}

function percent(value: number): string {
  return `${Math.round(value)}${NBSP}%`
}

function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE))
  if (minutes < 60) {
    return `${minutes}${NBSP}min`
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h${String(minutes % 60).padStart(2, '0')}`
  }

  return `${Math.floor(hours / 24)}j${NBSP}${hours % 24}h`
}
