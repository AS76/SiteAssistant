# Handoff Pixel → Codex — <titolo>

- **Data:** YYYY-MM-DD
- **Autore:** Pixel
- **Revisore:** Cleo
- **Stato:** bozza | pronto per implementazione | bloccato
- **Riferimento:** increment / issue / schermata
- **Design system:** `docs/design-system.md` + `docs/design-system.tokens.json`

## 1. Obiettivo e risultato utente

Cosa deve ottenere la persona che usa la schermata, in una frase verificabile.
Non descrivere la soluzione: descrivi l'esito.

## 2. Perimetro

- **Dentro:** …
- **Fuori:** …

## 3. Schermate e flusso

| # | Schermata | Azione primaria | Note |
|---|---|---|---|
| 1 | | | |

## 4. Stati obbligatori

Per ogni schermata o componente:

- **Default:**
- **Caricamento:** skeleton / spinner, cosa resta visibile
- **Vuoto:** testo, azione, distinzione da errore
- **Errore:** messaggio, retry, dati conservati
- **Offline / sync:** badge, coda, conflitto
- **Disabilitato:** motivo visibile

## 5. Componenti e token

| Componente | Variante | Token usati | Note |
|---|---|---|---|
| Button | primary / secondary | `--green`, `--line`, `--ink` | |
| Badge | stato | varianti esistenti | testo + colore |
| Panel | | `--line`, `--shadow`, raggio 12px | |

**Nessun token nuovo.** Se serve un'eccezione, elencarla qui con motivo e chiedere approvazione.

## 6. Responsive

- **390px:** …
- **768px:** …
- **Desktop (>1150px):** …
- **Non deve mai sparire:** stato, azione primaria, identificativo, motivo di blocco.

## 7. Accessibilità

- Contrasto: …
- Touch target: min 44×44 su coarse
- Focus: ring `#d89a44`, ordine di tabulazione
- Testi alternativi foto: …
- Annunci: errore `role="alert"`, loading `aria-busy`
- Verifiche manuali: tastiera, zoom 200%, 360px

## 8. Permessi e validazioni

| Azione | Ruolo | Vincolo | Errore atteso |
|---|---|---|---|
| | | | |

Regole server-side obbligatorie (non solo UI): …

## 9. Dati e API attese

- Entità e campi:
- Endpoint e metodi:
- Errori: 403 / 409 / 422
- Idempotenza e coda offline:

## 10. Criteri di accettazione

1. …
2. …

Devono essere verificabili senza interpretazione.

## 11. Domande aperte e decisioni

- [ ] …

## 12. Cosa non è incluso

…
