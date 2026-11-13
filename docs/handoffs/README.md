# Handoff Pixel → Codex

Questa cartella contiene gli handoff di design prodotti da Pixel e revisionati da Cleo.

**Regole**
- Un file per incremento: `YYYY-MM-DD-<slug>.md`, copiato da [`TEMPLATE.md`](TEMPLATE.md).
- Nessun codice nell'handoff: solo comportamento, componenti, token, stati, validazioni e criteri di accettazione.
- Codex implementa dal file; se qualcosa non è specificato, lo segnala invece di inventarlo.
- Pixel non modifica il codice di prodotto. Cleo coordina e verifica la completezza.
- I token vengono da `docs/design-system.md` e `docs/design-system.tokens.json`. Nessun valore nuovo senza approvazione.

**Ciclo**
1. Pixel scrive l'handoff.
2. Cleo verifica che sia completo e coerente con il design system.
3. Codex implementa e cita l'handoff nel commit/PR.
4. Pixel verifica l'esito visivo; le differenze tornano nell'handoff come revisione.
