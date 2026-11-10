# Cost impacts — incremento 14

Modulo backend implementato, senza UI dedicata o servizi esterni attivati. Le
migrazioni `013_cost_impacts.sql` per PostgreSQL e SQLite aggiungono claim interni
scrivibili e i relativi collegamenti alle deviations. Non sono una famiglia di
export e non modificano gli stati importati. Nessuna migrazione di produzione è
stata applicata da questo incremento.

In PostgreSQL le tabelle usano lo schema scelto dalla connessione (`app` per
impostazione predefinita), come le migrazioni precedenti.

## API

Tutti gli endpoint richiedono una sessione autenticata e membership nel cantiere.

| Endpoint | Ruoli | Comportamento |
| --- | --- | --- |
| `GET /api/cost-impacts?site_id=<uuid>&status=open` | Tutti i membri | `site_id` obbligatorio; `status` facoltativo; ordine per creazione e ID |
| `GET /api/cost-impacts/:id` | Tutti i membri | Claim con array `deviations` dei record collegati |
| `POST /api/cost-impacts` | Editor, verifier, owner | Crea un claim in `open`, risponde 201 |
| `POST /api/cost-impacts/:id/transition` | Verifier, owner | Applica una transizione, risponde 200 |

Creazione con dati sintetici:

```json
{
  "site_id": "11111111-1111-4111-8111-111111111111",
  "title": "Synthetic claim",
  "deviation_ids": ["22222222-2222-4222-8222-222222222222"],
  "claim_amount": "1234.50"
}
```

Il titolo non può essere vuoto. Serve almeno una deviation esistente dello stesso
cantiere; ID ripetuti identificano un solo collegamento. Creazione e collegamenti
sono atomici. Autore e timestamp di creazione provengono dal server.

Transizioni consentite: `open → notification_sent → submitted → closed` e
`open → closed`. `closed` è terminale. La chiusura richiede un `result` tra
`settled`, `dropped`, `rejected` e imposta `closed_at` sul server. Il risultato non
è ammesso sulle altre transizioni. Esempio di chiusura:

```json
{ "to": "closed", "result": "settled", "settlement_amount": "1000.25" }
```

`claim_amount` e `settlement_amount` sono facoltativi, sia alla creazione sia
nelle transizioni. Una transizione conserva gli importi omessi; `null` li imposta
a NULL. Sono accettati numeri finiti e stringhe decimali, senza conversioni di
valuta, somme implicite o deduzioni di valuta. PostgreSQL conserva NUMERIC e
restituisce gli importi come stringhe, evitando conversioni in Number nel modulo;
SQLite usa la propria affinità NUMERIC e può arrotondare valori ad alta precisione.

Errori principali: 400 per input non valido o esito mancante, 401 senza sessione,
403 per ruolo/membership insufficienti, 404 per record assenti, 409 per deviazioni
di altro cantiere o transizioni non consentite/conflitti concorrenti. Le letture
dirette del modulo sono interne; il livello HTTP applica l'autorizzazione alle
letture, mentre le funzioni di scrittura controllano direttamente utente e ruolo.

## Verifiche

`tests/cost-impacts.test.mjs`, incluso in `tests/index.js`, verifica creazione,
filtri, dettagli, tutte le coppie di stati, esiti di chiusura, ruoli, membership,
rollback, chiusure concorrenti, vincoli SQL e replay della migrazione. Esegue gli
stessi casi su SQLite e PostgreSQL tramite PGlite; con `DB_DRIVER=pg` usa invece
il database di test PostgreSQL configurato secondo le protezioni esistenti.

Comandi: `npm test` e `npm run test:schema`.
