# session-gauge

Un mod pour Claude Code. Il affiche une ligne au-dessus de la zone de saisie qui montre où tu en es dans ta session :

```
Session ────────┼─ 2 % · reset 46 min   Semaine ━━━━───┼── 44 %   Contexte ━━──────── 25 %       Coût $3.47
```

- **Session** : la limite d'usage sur 5 heures, avec le temps restant avant sa réinitialisation.
- **Semaine** : la limite d'usage hebdomadaire.
- **Contexte** : le remplissage de la fenêtre de contexte de la conversation en cours.
- **Coût** : le coût de la session, tel que `/cost` le calcule.

## Lire les jauges

- Le trait plein `━` montre la part de la limite déjà consommée.
- Le repère `┼` marque le temps déjà écoulé dans la fenêtre. Si la barre remplie dépasse ce repère, tu consommes plus vite que le temps ne passe.
- La barre reste neutre tant que le rythme tient. Elle passe en orange quand, à ce rythme, la limite sera atteinte avant le reset (« ⚠ limite dans ~30 min »), et en rouge à partir de 90 %.
- Le contexte passe en orange à 60 % et en rouge à 85 %, où le mod suggère `/compact`.
- Quand la ligne manque de place, les détails secondaires s'effacent dans cet ordre : reset hebdo, coût, puis reset de session.

Les limites Session et Semaine ne s'affichent qu'avec un abonnement Claude (Pro ou Max), et seulement après la première réponse de la session.

## Installation

À l'invite d'une session Claude Code dans un terminal :

```
/plugin install session-gauge --marketplace sutter/session-gauge
```

Réponds `y` pour ajouter la marketplace, puis choisis la portée utilisateur.

Depuis un shell :

```bash
claude plugin install session-gauge --marketplace sutter/session-gauge
```

Dans l'app desktop, où `/plugin` ne fonctionne pas : clique sur **+** à côté de la zone de saisie, puis **Plugins**, **Add marketplace** avec `sutter/session-gauge`, puis **Add plugin**.

Le bandeau apparaît dans les nouvelles sessions. Développé et testé avec Claude Code 2.1.299.

## Mise à jour

```bash
claude plugin update session-gauge@sutterlity-mods
```

Puis `/reload-plugins` dans une session ouverte, ou redémarre-la.
