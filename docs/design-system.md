# SiteAssistant — Design System

Stable reference for UI, UX and handoff. Source of the values: `app/styles.css` (`:root`). The values are exported in [`design-system.tokens.json`](design-system.tokens.json).

**Direction:** «Quaderno di cantiere» — warm paper, ink and brick; Source Serif 4 for headings, Source Sans 3 for interface text.

**Main rule:** no colour, font or radius outside these tokens. Exceptions are declared and approved, never introduced silently.

## 1. Tokens

| Token | Value | Use |
|---|---|---|
| `--paper` | `#FAF6EC` | Page background |
| `--surface` | `#FFFCF5` | Cards, panels, dialogs |
| `--surface-2` | `#F2ECDD` | Secondary surfaces, selected rows, demo banners |
| `--surface-3` | `#E9E1CE` | Subtle bands and separators |
| `--ink` | `#1E1A15` | Primary text, headings, values |
| `--ink-2` | `#544E46` | Secondary text, labels, quiet actions |
| `--ink-3` | `#8B8378` | Tertiary metadata; only at ≥12px, never essential text |
| `--rule` | `#E3DAC8` | Borders, separators, tables |
| `--rule-2` | `#CFC3AC` | Stronger borders and controls |
| `--brick` | `#8E2E24` | Dominant action, active navigation, emphasis |
| `--brick-deep` | `#6E211A` | Hover/pressed dominant action |
| `--brick-tint` | `#F7EAE4` | Site code, light emphasis |
| `--radius` | `3px` | Notebook surfaces and notebook controls |
| `--sans` | Source Sans 3 + system fallback | Interface text |
| `--serif` | Source Serif 4 + Georgia fallback | Headings, brand, page titles |
| `--mono` | IBM Plex Mono + fallback | Codes, IDs, timestamps, numeric tables |

Historical aliases are kept so modules not yet rewritten inherit the new palette:

| Alias | Value |
|---|---|
| `--muted` | `var(--ink-2)` |
| `--line` | `var(--rule)` |
| `--green` | `var(--ink-2)` |
| `--pale` | `var(--surface-2)` |
| `--orange` | `var(--ink-2)` |
| `--sidebar` | `var(--surface-2)` |
| `--shadow` | `none` |

**Contrast, calculated on the token values:** ink on paper **16.03:1**; ink-2 on paper **7.62:1**; ink-3 on paper **3.47:1** (large text or non-essential metadata only); paper on brick **7.58:1**; surface on brick **7.99:1**.

### Known gaps

- `--ink-3` is below 4.5:1: use it for metadata at 12px or larger, never for an instruction or a required value.
- Legacy module cards and forms still use their historical component radii (8/9/12px) and semantic badge colours; they are not tokens. The notebook surfaces use `--radius: 3px`.
- Do not add a new hex value for a state: use word + glyph + existing token.

## 2. Typography

Families: **Source Sans 3** (interface and body), **Source Serif 4** (headings and brand), **IBM Plex Mono** (codes, IDs, timestamps).

| Role | Size / weight | Notes |
|---|---|---|
| Body | 15px / 1.5 | Application base |
| Notebook page title | 32px / 600, serif | `--page-title-size`, line-height 1.05 |
| Standard page H1 | 30px / 650 | Existing module headings; 26px at ≤800px |
| Brand | 19px / 600, serif | Sidebar and topbar |
| Panel H2 | 15px / 650 | Panel header |
| Section heading | 12.5px / 700, uppercase | Notebook section head; ink-2 rule below |
| Eyebrow | 10px / 750, uppercase | Context only, not a heading |
| KPI | 35px / 620 | Numeric value |
| Table label | 11px / 600 | Header |
| Table cell | 12px | Minimum for tabular data |
| Badge / state | 11px / 600 | Short labels only |

Do not introduce new weights or scales. For secondary hierarchy use `--ink-2`, not new sizes. Body text never goes below 12px; tabular data never below 12px.

## 3. Shape and spacing

- **`--radius: 3px`** for notebook surfaces and notebook controls.
- Legacy components still use 8px inputs/buttons, 9–12px cards and 15px dialogs until they are rewritten.
- Main padding: `var(--shell-gutter)` — 16px below 640px, 24px at ≥640px, up to 38px on wide screens.
- Notebook width: max 900px, centered; record tables may use the full width.
- Touch target: minimum **44×44px** on pointer coarse; primary notebook action **48px**.
- Focus: `outline: 2px solid var(--ink-2); outline-offset: 2px` on every interactive element, including `summary`. Never `outline: none` without a replacement.

## 4. Components

### Button
- **Primary:** `--brick` background, `--surface` text, `--brick` border; hover `--brick-deep`.
- **Secondary:** `--surface`, `--rule-2` border, `--ink` text; hover `--surface-2`.
- **Danger:** existing component red (`#a73c37` text, `#e5c4c1` border). It is not a token: use only for destructive actions that are already planned.
- **Disabled:** opacity 0.5, `cursor: not-allowed`.
- **Loading:** label replaced or spinner, `aria-busy="true"`, disabled.
- One dominant action per view. Secondary actions stay text or outline.

### Badge and state
- Base: 11px, padding 4px 8px, 5px radius, weight 600.
- Status uses **word + glyph**: `○ da fare`, `▶ in corso`, `◆ da verificare`, `▲ bloccata`, `✓ chiusa`, `→ in arrivo`.
- Colour is never the only channel.
- Legacy status variants still exist for modules not yet rewritten; do not replicate their hex values elsewhere.

### Panel / Card
- 1px `--rule` border, notebook radius 3px (legacy 12px), no shadow.
- Header with H2 and actions.
- Error state: inline message, `--rule-2` border, Retry button.

### Table
- Header 11px on `--surface-2`; cells 12px; bottom border `--rule`.
- On mobile: stacked cards or contained horizontal scroll. Never 9 columns at 9px.

### Form
- Visible label above the field; asterisk + text for required fields, not colour alone.
- Error below the field, with icon and text; `role="alert"` for submit errors.
- Notebook fields use `--radius: 3px`; legacy fields keep 8px.

### Empty state
- Centred, generous padding, strong title, `--ink-2` text, a single primary action.
- Always distinguish **empty** from **loading** and from **error**.

### Dialog
- `--surface` background, `--rule` border, notebook radius 3px (legacy 15px), focus trap, Esc to close, initial focus on the safe action.
- Confirmation for destructive actions; otherwise a toast with Undo for 8–10 s.

## 5. Responsive

| Breakpoint | Behaviour |
|---|---|
| ≥ 1180px | Fixed rail 216px; hide topbar brand and topbar navigation; show actor name; site control max 420px |
| 640–1179px | Topbar with brand/actions, site + operational day, horizontal navigation; no rail |
| < 640px | Bottom navigation 56px + safe area; topbar brand/actions; site selector on its own row; page title 26px |
| ≤ 520px | Legacy module grids collapse; tables become cards; filters wrap; two-column KPI |

What must never disappear on mobile: offline/sync state, status badge with text, the role's primary action, the record identifier, the reason for a block or a rejection.

## 6. Accessibility — non-negotiable rules

1. AA contrast: 4.5:1 for normal text, 3:1 for large text and graphic indicators.
2. Never communicate a state with colour alone: text, icon or shape is required.
3. Touch target ≥ 44×44 on pointer coarse; no font below 12px for tabular data.
4. Visible focus on every interactive element; tab order = DOM order.
5. Errors and confirmations announced (`role="alert"`, `aria-live`), not only visual.
6. Photos: descriptive alt (what, where, when), not the file name.
7. Destructive actions: explicit confirmation or undo; never silent.
8. Viewport zoom must not be disabled; if a legacy rule blocks it, it is a known defect, not a design rule.

## 7. What not to do

- Introduce new hex values, gradients, fonts or radii without a token proposal.
- Use `--ink-3` for small essential text.
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

## Approved exceptions

- **Legacy module surfaces (2026-11-21):** cards and forms outside Oggi, Diario, Attività and Deviazioni keep their historical radii and semantic badge colours while the redesign proceeds module by module. They inherit the new palette through the aliases.
