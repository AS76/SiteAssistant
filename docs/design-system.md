# SiteAssistant — Design System

Stable reference for UI, UX and handoff. Source of the values: `app/styles.css` (`:root`). The values are exported in [`design-system.tokens.json`](design-system.tokens.json).

**Main rule:** no colour, font, radius or spacing outside these tokens. Exceptions are declared and approved, never introduced silently.

## 1. Tokens

| Token | Value | Use | Contrast note |
|---|---|---|---|
| `--ink` | `#182c32` | Primary text, headings, values | 13.48:1 on `--paper`; 14.0:1 on white |
| `--muted` | `#5b6c72` | Secondary text, labels, captions | 5.48:1 on white; 5.08:1 on `--paper`: AA for normal text |
| `--line` | `#dce4e5` | Borders, separators, tables | Graphic element only |
| `--paper` | `#f4f7f6` | Page background | — |
| `--green` | `#126c57` | Primary action, accents, completed state | 6.35:1 on white; white on green 6.35:1 |
| `--pale` | `#e7f3ec` | Soft background, highlight, skeleton | — |
| `--orange` | `#c27320` | Soft alert, due dates, high severity | 3.64:1 on white: **large, bold text or icon only**; never small informational text on its own |
| `--sidebar` | `#142c30` | Navigation | Nav text `#c5d7d7` on sidebar: 9.82:1 |
| `--shadow` | `0 8px 32px #142c3009` | Panel/card elevation | — |
| `--mono` | IBM Plex Mono + fallback | Codes, IDs, timestamps | — |

**These are not tokens and must not be invented:** error red, `to_verify` blue, intermediate greys, alternative greens. If they are needed, they are proposed as new tokens and approved.

### Known gaps

- **Closed (2026-11-13): focus contrast.** A 3px `--green` (`#126c57`) outline with a white separation ring provides 6.35:1 at the green/white edge, above the 3:1 required for non-text indicators.
- Badges at 10px are below the comfort threshold for long text: use them for short labels, not for sentences.
- **Closed (2026-11-13): secondary text contrast.** `--muted` is `#5b6c72`: 5.08:1 on `--paper`, 5.48:1 on white, both above AA for normal text.

## 2. Typography

Family: **IBM Plex Sans** (UI and text), **IBM Plex Mono** (codes, IDs, timestamps).

| Role | Size / weight | Notes |
|---|---|---|
| Body | 14px / 1.5 | Application base |
| Page H1 | 30px / 650, letter-spacing -1px | One per screen |
| Panel H2 | 15px / 650 | Panel header |
| Eyebrow | 10px / uppercase, letter-spacing 1.8px, `--green` | Context, not a heading |
| KPI | 35px / 620, letter-spacing -1px | Numeric value |
| Table label | 10px / uppercase, `--muted` | Header |
| Table cell | 12px | Minimum for tabular data |
| Badge | 10px / 600 | Short labels only |

Do not introduce new weights or scales. For secondary hierarchy use `--muted`, not new sizes.

## 3. Shape and spacing

- Radii: **8px** inputs/buttons/thumbnails, **12px** cards/panels, **15px** dialogs.
- Main padding: **35px 38px** desktop; **24-27px 15-20px** mobile.
- Card/panel: padding **20-21px**; grid gap **16px**; overview **23px**.
- KPI grid: 4 columns, 16px gap. Overview: `1.7fr + 1fr`.
- Touch target: minimum **44×44px** on pointer coarse; standard buttons `padding: 10px 15px`.
- Focus: `outline: 3px solid var(--green); outline-offset: 3px; box-shadow: 0 0 0 3px #fff` on every interactive element, including `summary`. The white separation ring keeps the green/white edge at 6.35:1, including in the dark sidebar. Summaries inside clipped panels use `outline-offset: -6px` and `box-shadow: inset 0 0 0 3px #fff` to keep both rings visible. Never `outline: none` without a replacement.

## 4. Components

### Button
- Primary: `--green` background, white text, `--green` border. Hover: `#0d5544` (a variant inside the green token).
- Secondary: white, `--line` border, `--ink` text. Hover: `#eef3f0`.
- Danger: text `#a73c37`, border `#e5c4c1`. It is not a token: use it only for destructive actions that are already planned.
- Disabled: opacity 0.5, `cursor: not-allowed`.
- Loading: label replaced or spinner, `aria-busy="true"`, disabled.

### Badge
- Base: 10px, padding 4px 8px, radius 5px, weight 600.
- Status variants: `todo` grey, `in_progress` green, `blocked` orange, `to_verify` blue, `closed` green.
- Always **text + colour**: colour is never the only channel.
- The `to_verify` blue has no hex value in `:root`: it is a component variant, not a token. Do not replicate it elsewhere.

### Panel / Card
- 1px `--line` border, 12px radius, `--shadow`, header with H2 and actions.
- Error state: inline message, `--orange` border, Retry button.

### Table
- Header 10px on `#edf2ef`; cells 12px; bottom border `#edf1ef`.
- On mobile: stacked cards or contained horizontal scroll. Never 9 columns at 9px.

### Form
- Visible label above the field; asterisk + text for required fields, not colour alone.
- Error below the field, with icon and text; `role="alert"` for submit errors.
- Radius 8px; border `#cdd9d6`.

### Empty state
- Centred, padding 42px 20px, strong title, `--muted` text, a single primary action.
- Always distinguish **empty** from **loading** and from **error**.

### Dialog
- Radius 15px, backdrop `#10282e80`, focus trap, Esc to close, initial focus on the safe action.
- Confirmation for destructive actions; otherwise a toast with Undo for 8-10 s.

## 5. Responsive

| Breakpoint | Behaviour |
|---|---|
| > 1150px | Sidebar 232px, KPI 4 col, overview 1.7fr + 1fr |
| ≤ 1150px | Sidebar 195px, board 3 col, site grid 2 col |
| ≤ 800px | Static sidebar on top, horizontal nav, overview 1 col, KPI 4 compressed col |
| ≤ 520px | KPI 2×2, board with horizontal scroll and snap, toolbar wrapping, two-row topbar, tables → cards |

What must never disappear on mobile: offline/sync state, status badge with text, the role's primary action, the record identifier, the reason for a block or a rejection.

## 6. Accessibility — non-negotiable rules

1. AA contrast: 4.5:1 for normal text, 3:1 for large text and graphic indicators.
2. Never communicate a state with colour alone: text, icon or shape is required.
3. Touch target ≥ 44×44 on pointer coarse; no font below 12px for tabular data.
4. Visible focus on every interactive element; tab order = DOM order.
5. Errors and confirmations announced (`role="alert"`, `aria-live`), not only visual.
6. Photos: descriptive alt (what, where, when), not the file name.
7. Destructive actions: explicit confirmation or undo; never silent.

## 7. What not to do

- Introduce new hex values, gradients, fonts or radii.
- Use `--orange` for small sentences on white.
- Replace labels with icons only on touch.
- Hide filters or records without an alternative path.
- Use relative dates only in audit contexts.
- Drop the focus ring, or remove it without a replacement.

## 8. Maintenance

1. The value is born in `app/styles.css` (`:root`).
2. `design-system.tokens.json` is regenerated from the same block.
3. Pixel updates this document for semantics and usage; Codex implements values and consistency tests.
4. A test/CI should fail if CSS and JSON diverge. The automated check is Codex's responsibility; meanwhile this is the manual verification, run from the repository root:

```sh
python3 - <<'PY'
import re, json, sys
css = open('app/styles.css').read()
body = re.search(r':root\{(.*?)\}', css, re.S).group(1)
live = {n: v.strip() for n, v in re.findall(r'(--[a-z0-9-]+)\s*:\s*([^;]+);', body)}
doc = json.load(open('docs/design-system.tokens.json'))['tokens']
if live != doc:
    diff = {k: (live.get(k), doc.get(k)) for k in set(live) | set(doc) if live.get(k) != doc.get(k)}
    print('Token drift:', diff)
    sys.exit(1)
print('Token OK:', len(live))
PY
```

5. Every exception must be written in the "Approved exceptions" section with reason and date.
