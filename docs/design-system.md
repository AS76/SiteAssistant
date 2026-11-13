# SiteAssistant — Design System

Riferimento stabile per UI, UX e handoff. Fonte dei valori: `app/styles.css` (`:root`). I valori sono esportati in [`design-system.tokens.json`](design-system.tokens.json).

**Regola principale:** nessun colore, font, raggio o spaziatura fuori da questi token. Le eccezioni si dichiarano e si approvano, non si introducono in silenzio.

## 1. Token

| Token | Valore | Uso | Nota di contrasto |
|---|---|---|---|
| `--ink` | `#182c32` | Testo primario, titoli, valori | 13,48:1 su `--paper`; 14,0:1 su bianco |
| `--muted` | `#64757b` | Testo secondario, label, caption | 4,80:1 su bianco; **4,46:1 su `--paper`**: appena sotto AA per testo normale, non usarlo su paper per testi informativi |
| `--line` | `#dce4e5` | Bordi, separatori, tabelle | Solo elemento grafico |
| `--paper` | `#f4f7f6` | Sfondo pagina | — |
| `--green` | `#126c57` | Azione primaria, accenti, stato completato | 6,35:1 su bianco; bianco su green 6,35:1 |
| `--pale` | `#e7f3ec` | Sfondo tenue, highlight, skeleton | — |
| `--orange` | `#c27320` | Alert soft, scadenze, severità alta | 3,64:1 su bianco: **solo testo grande, bold o con icona**; mai testo informativo piccolo da solo |
| `--sidebar` | `#142c30` | Navigazione | Testo nav `#c5d7d7` su sidebar: 9,82:1 |
| `--shadow` | `0 8px 32px #142c3009` | Elevazione pannelli/card | — |
| `--mono` | IBM Plex Mono + fallback | Codici, ID, timestamp | — |

**Non sono token e non vanno inventati:** rosso d'errore, blu `to_verify`, grigi intermedi, verdi alternativi. Se servono, vanno proposti come nuovi token e approvati.

### Gap noti

- Il focus ring `#d89a44` su bianco ha 2,43:1 (sotto il 3:1 richiesto per indicatori non testuali). Non va rimosso: va corretto il token o aggiunto un secondo segnale (spessore/offset) finché non viene approvato un valore migliore.
- I badge a 10px sono sotto la soglia di comfort per testo lungo: usarli per etichette brevi, non per frasi.
- `--muted` su `--paper` è appena sotto AA per testo normale: sui pannelli usare `--muted` su bianco, oppure `--ink`.

## 2. Tipografia

Famiglia: **IBM Plex Sans** (UI e testi), **IBM Plex Mono** (codici, ID, timestamp).

| Ruolo | Dimensione / peso | Note |
|---|---|---|
| Body | 14px / 1.5 | Base dell'app |
| H1 pagina | 30px / 650, letter-spacing -1px | Una sola per schermata |
| H2 pannello | 15px / 650 | Header dei panel |
| Eyebrow | 10px / uppercase, letter-spacing 1.8px, `--green` | Contesto, non titolo |
| KPI | 35px / 620, letter-spacing -1px | Valore numerico |
| Label tabella | 10px / uppercase, `--muted` | Header |
| Cella tabella | 12px | Minimo per dati tabellari |
| Badge | 10px / 600 | Solo etichette brevi |

Non introdurre nuovi pesi o scale. Per gerarchie secondarie usare `--muted`, non nuove dimensioni.

## 3. Forma e spaziatura

- Raggi: **8px** input/bottoni/thumbnail, **12px** card/panel, **15px** dialog.
- Padding main: **35px 38px** desktop; **24-27px 15-20px** mobile.
- Card/panel: padding **20-21px**; gap griglie **16px**; overview **23px**.
- Griglia KPI: 4 colonne, gap 16px. Overview: `1.7fr + 1fr`.
- Touch target: minimo **44×44px** su pointer coarse; pulsanti standard `padding: 10px 15px`.
- Focus: `outline: 3px solid #d89a44; outline-offset: 3px` su ogni elemento interattivo. Mai `outline: none` senza sostituto.

## 4. Componenti

### Button
- Primary: fondo `--green`, testo bianco, bordo `--green`. Hover: `#0d5544` (variante interna al token green).
- Secondary: bianco, bordo `--line`, testo `--ink`. Hover: `#eef3f0`.
- Danger: testo `#a73c37`, bordo `#e5c4c1`. Non è un token: usarlo solo per azioni distruttive già previste.
- Disabled: opacità 0.5, `cursor: not-allowed`.
- Loading: label sostituita o spinner, `aria-busy="true"`, disabilitato.

### Badge
- Base: 10px, padding 4px 8px, raggio 5px, peso 600.
- Varianti stato: `todo` grigio, `in_progress` verde, `blocked` arancio, `to_verify` blu, `closed` verde.
- Sempre **testo + colore**: il colore non è mai l'unico canale.
- Il blu `to_verify` non ha un valore esadecimale in `:root`: è una variante di componente, non un token. Non replicarlo altrove.

### Panel / Card
- Bordo 1px `--line`, raggio 12px, `--shadow`, header con H2 e azioni.
- Error state: messaggio inline, bordo `--orange`, pulsante Riprova.

### Tabella
- Header 10px su `#edf2ef`; celle 12px; bordo inferiore `#edf1ef`.
- Su mobile: card impilate o scroll orizzontale contenuto. Mai 9 colonne a 9px.

### Form
- Label visibile sopra il campo; asterisco + testo per i campi obbligatori, non solo colore.
- Errore sotto il campo, con icona e testo; `role="alert"` per gli errori di invio.
- Raggio 8px; bordo `#cdd9d6`.

### Empty state
- Centrato, padding 42px 20px, titolo forte, testo `--muted`, una sola azione primaria.
- Distinguere sempre **vuoto** da **caricamento** e da **errore**.

### Dialog
- Raggio 15px, backdrop `#10282e80`, focus trap, Esc per chiudere, focus iniziale sull'azione sicura.
- Conferma per azioni distruttive; in alternativa toast con Annulla 8-10 s.

## 5. Responsive

| Breakpoint | Comportamento |
|---|---|
| > 1150px | Sidebar 232px, KPI 4 col, overview 1.7fr + 1fr |
| ≤ 1150px | Sidebar 195px, board 3 col, site grid 2 col |
| ≤ 800px | Sidebar statica in alto, nav orizzontale, overview 1 col, KPI 4 col compresse |
| ≤ 520px | KPI 2×2, board a scroll orizzontale con snap, toolbar a capo, topbar a due righe, tabelle → card |

Cosa non deve mai sparire su mobile: stato offline/sync, badge di stato con testo, azione primaria del ruolo, identificativo del record, motivo di blocco/rifiuto.

## 6. Accessibilità — regole non negoziabili

1. Contrasto AA: 4,5:1 per testo normale, 3:1 per testo grande e indicatori grafici.
2. Mai stato comunicato solo con il colore: serve testo, icona o forma.
3. Touch target ≥ 44×44 su pointer coarse; nessun font < 12px per dati tabellari.
4. Focus visibile su ogni interattivo; ordine di tabulazione = ordine DOM.
5. Errori e conferme annunciati (`role="alert"`, `aria-live`), non solo visivi.
6. Foto: alt descrittivo (cosa, dove, quando), non il nome file.
7. Azioni distruttive: conferma esplicita o annullamento; mai silenziose.

## 7. Cosa non fare

- Introdurre nuovi hex, gradienti, font o raggi.
- Usare `--orange` per frasi piccole su bianco.
- Sostituire etichette con sole icone su touch.
- Nascondere filtri o record senza un percorso alternativo.
- Usare date solo relative in contesti di audit.
- Lasciare il focus ring o rimuoverlo senza sostituto.

## 8. Manutenzione

1. Il valore nasce in `app/styles.css` (`:root`).
2. Si rigenera `design-system.tokens.json` dallo stesso blocco.
3. Pixel aggiorna questo documento per semantica e uso; Codex implementa valori e test di coerenza.
4. Un test/CI dovrebbe fallire se CSS e JSON divergono. Il controllo automatico è di competenza Codex; nel frattempo la verifica manuale è questa, da eseguire dalla radice del repo:

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

5. Ogni eccezione va scritta nella sezione "Eccezioni approvate" con motivo e data.
