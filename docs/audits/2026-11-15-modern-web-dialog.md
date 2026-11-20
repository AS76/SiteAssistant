# Audit — Modern Web Guidance applicata al frontend SiteAssistant

Data: 2026-11-15 · Autore: Cleo · Ambito: `app/` (vanilla JS, unica dipendenza `pg` lato server)
Fonte delle raccomandazioni: Modern Web Guidance, team Chrome — guide `dialog`, `html`, `accessibility` (consultate via CLI, nessuna skill installata).

## Metodo

1. `legacy-scan app` → **0 findings** su 33 guide (nessun pattern legacy rilevato).
2. Lettura delle guide `dialog` e `accessibility` e confronto con l'implementazione reale (`app/app.mjs`, `app/index.html`, `app/styles.css`).
3. Classificazione della gravità con Jev (`decision_evaluate`), registrata in `vps-ops/state/jev-verdicts.jsonl`.

Base già corretta, da riconoscere: `<dialog id="modal" aria-labelledby="modal-title">` senza `role="dialog"` né `aria-modal`, apertura con `showModal()`, pulsante di chiusura con `aria-label`, ritorno del focus gestito dal browser. Il grosso è a posto.

## Rilievi

### R1 — Scrolling "a catena" dietro la finestra modale (miglioramento, basso costo)

La guida marca come **obbligatorie** due regole CSS assenti in `styles.css`:

```css
dialog:modal { overscroll-behavior: contain; }
dialog::backdrop { overflow: hidden; overscroll-behavior: contain; }
```

Senza, un gesto di scroll sopra il backdrop o dentro la finestra fa scorrere la pagina sottostante. Si nota soprattutto su mobile e con contenuti lunghi.

**Impatto**: fastidio, nessun blocco. **Costo**: 4 righe di CSS. **Riferimento**: guida `dialog`, sezione "Prevent page scroll under modal".

### R2 — Esc scarta i dati digitati senza avviso (alta priorità)

`app/app.mjs:2865` intercetta `cancel` solo per incrementare `modalVersion`; non blocca la chiusura e non avvisa. Un utente che compila un form lungo (evento HSE, certificazione) e preme Esc **perde quanto scritto** senza conferma.

La guida indica la soluzione: `closedby="none"` più un percorso di conferma, oppure `requestClose()` con controllo "form sporco".

**Impatto**: perdita di lavoro dell'utente; recuperabile riscrivendo, quindi non blocca il flusso, ma è il rilievo più serio dei tre.
**Nota di metodo**: Jev ha dato `bloccante` 0,69 con confidenza 0,53. Ho classificato **non bloccante, alta priorità**: il danno è reale ma non impedisce il completamento dell'attività. Verdetto divergente registrato (`changed_decision: true`), vince l'evidenza.

### R3 — Focus iniziale non garantito nelle finestre senza campi (media priorità)

`showModal()` (`app/app.mjs:2393-2401`) mette il focus sul primo campo, se esiste. Nelle finestre **senza campi** — conferme di eliminazione, stati di caricamento — il focus resta dov'era, e nelle conferme distruttive non va sull'azione sicura (Annulla) come raccomanda la guida.

**Impatto**: chi naviga da tastiera o con screen reader non ha un punto di partenza chiaro. **Costo**: poche righe (`autofocus` sul pulsante Annulla, focus sul contenitore per gli stati di caricamento).

## Cosa NON è un problema

- `role="dialog"` e `aria-modal`: correttamente assenti (il `<dialog>` modale li fornisce).
- Apertura con `showModal()`: corretta.
- Etichette dei campi, `required`, `autocomplete`, `aria-describedby` sugli hint: presenti.
- `legacy-scan`: zero pattern obsoleti.

## Proposta di intervento (non applicata)

| Rilievo | Chi | Costo | Rischio |
|---|---|---|---|
| R1 overscroll | Codex, patch CSS | 4 righe | nullo |
| R2 Esc + form sporco | Codex, con test dedicato | ~40 righe + 2 test | medio: tocca il ciclo di chiusura di tutte le modali |
| R3 focus | Codex | ~15 righe | basso |

R2 va fatto con un test che apra un form, digiti un valore, prema Esc e verifichi che il contenuto resti. Senza quel test è una modifica che sembra innocua e rompe l'uso quotidiano.

## Fonti consultate

- `npx modern-web-guidance@latest legacy-scan app` → 0 findings
- Guida `dialog` (regole 1-3, chiusura, focus, overscroll)
- Guida `accessibility` (controllo nominato via `search`)
