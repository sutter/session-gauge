import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf, SessionUsage } from 'claude-code'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const T0 = Date.parse('2026-10-16T10:00:00Z')

const band = (bodyColumns: number): RenderPropsOf['AbovePrompt'] => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
})

/** Two hours into the 5 h window with 80 % used: on pace to run out in 30 min, before the reset in 3 h. */
const USAGE: SessionUsage = {
  startedAt: T0 - 90 * MINUTE,
  context: { tokens: 124_000, window: 200_000, percent: 62 },
  rateLimits: [
    { kind: 'seven_day', percentUsed: 19, resetsAt: new Date(T0 + 72 * HOUR).toISOString() },
    { kind: 'five_hour', percentUsed: 80, resetsAt: new Date(T0 + 3 * HOUR).toISOString() },
  ],
  cost: { usd: 3.42 },
}

/** Stands for the engine beneath the plugin: usage as the test sets it, and the toasts it raised. */
function engine(on: On, initial: SessionUsage) {
  const state = { usage: initial, toasts: [] as string[] }
  mock.store(on)
  on('session.usage', () => ({ value: state.usage }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  return state
}

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

/** The text of one gauge, found by its key; undefined when the line left it out. */
async function gauge(
  ui: { find: (query: { key: string }) => Promise<{ text: string } | undefined> },
  id: string,
): Promise<string | undefined> {
  return (await ui.find({ key: `gauge-${id}` }))?.text
}

test('a wide line shows every gauge, the session first and the cost aside', async ($, on) => {
  mock.clock(on, { now: T0 })
  engine(on, USAGE)
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-gauge', surface, component: 'AbovePrompt', props: band(160) })

    expect(await gauge(ui, 'five_hour')).toMatch(/^Session\s*[━─┿┼]{16}\s*80\s% · reset 3h00 ⚠ limite dans ~30\smin$/)
    expect(await gauge(ui, 'seven_day')).toMatch(/^Semaine\s*[━─┿┼]{16}\s*19\s% · reset 3j\s0h$/)
    expect(await gauge(ui, 'context')).toMatch(/^Contexte\s*[━─]{16}\s*62\s%$/)
    expect(await gauge(ui, 'cost')).toMatch(/^Coût\s*\$3\.42$/)
    // The label stands apart from its bar, spaced by the layout.
    expect(await ui.find({ type: 'Text', text: /^Session$/ })).toBeDefined()

    await ui.unmount()
  }
})

test('a short line drops the weekly reset, then the cost, before shrinking the bars', async ($, on) => {
  mock.clock(on, { now: T0 })
  engine(on, USAGE)
  await $.session.start(START)

  const ui = await $.ui.mount({ plugin: 'session-gauge', surface: 'desktop', component: 'AbovePrompt', props: band(100) })
  expect(await gauge(ui, 'five_hour')).toMatch(/^Session\s*[━─┿┼]{6}\s*80\s% · reset 3h00 ⚠ limite dans ~30\smin$/)
  expect(await gauge(ui, 'seven_day')).toMatch(/^Semaine\s*[━─┿┼]{6}\s*19\s%$/)
  expect(await gauge(ui, 'cost')).toBeUndefined()
  await ui.unmount()

  const narrow = await $.ui.mount({ plugin: 'session-gauge', surface: 'terminal', component: 'AbovePrompt', props: band(60) })
  expect(await gauge(narrow, 'five_hour')).toMatch(/^Session\s*[━─┿┼]{6}\s*80\s% ⚠ limite dans ~30\smin$/)
  await narrow.unmount()
})

test('the legend about the tick is shown once', async ($, on) => {
  mock.clock(on, { now: T0 })
  const state = engine(on, USAGE)

  await $.session.start(START)
  await $.session.start(START)

  expect(state.toasts).toHaveLength(1)
  expect(state.toasts[0]).toContain('le trait ┼ marque le temps écoulé')
})

test('the gauges follow the clock and each new measurement', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const state = engine(on, USAGE)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'session-gauge', surface: 'terminal', component: 'AbovePrompt', props: band(160) })

  await clock.advance(HOUR)
  expect(await gauge(ui, 'five_hour')).toMatch(/^Session\s*[━─┿┼]+\s*80\s% · reset 2h00/)

  const resetsAt = new Date(T0 + 3 * HOUR).toISOString()
  state.usage = { ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 95, resetsAt }] }
  await $.session.measure({ context: USAGE.context, rateLimits: state.usage.rateLimits, changed: ['rateLimits'] })
  expect(await gauge(ui, 'five_hour')).toMatch(/^Session\s*[━─┿┼]+\s*95\s% · reset 2h00/)
  expect(await gauge(ui, 'seven_day')).toBeUndefined()

  await clock.advance(2 * HOUR + MINUTE)
  expect(await gauge(ui, 'five_hour')).toMatch(/^Session\s*─+\s*0\s% · réinitialisée$/)
  await ui.unmount()
})

test('a nearly full context points to /compact', async ($, on) => {
  mock.clock(on, { now: T0 })
  engine(on, { ...USAGE, context: { tokens: 180_000, window: 200_000, percent: 90 } })
  await $.session.start(START)

  const ui = await $.ui.mount({ plugin: 'session-gauge', surface: 'desktop', component: 'AbovePrompt', props: band(160) })
  expect(await gauge(ui, 'context')).toMatch(/^Contexte\s*[━─]+\s*90\s% · \/compact$/)
  await ui.unmount()
})

test('the line waits for a first reading of the limits', async ($, on) => {
  mock.clock(on, { now: T0 })
  engine(on, { startedAt: T0, context: { window: 200_000 }, rateLimits: [] })
  await $.session.start(START)

  const ui = await $.ui.mount({ plugin: 'session-gauge', surface: 'desktop', component: 'AbovePrompt', props: band(100) })
  expect(await gauge(ui, 'limits')).toMatch(/^Limites\s*en attente$/)
  expect(await gauge(ui, 'context')).toMatch(/^Contexte\s*─+\s*–$/)
  expect(await gauge(ui, 'cost')).toBeUndefined()
  await ui.unmount()
})
