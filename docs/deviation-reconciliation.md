# Riconciliazione delle cronologie deviazioni

La riconciliazione elenca anomalie senza modificare date, stati o record. Non richiede migrazioni né nuove dipendenze.

`GET /api/deviations/reconciliation?site_id=<uuid>` richiede un membro del cantiere
(owner, editor, verifier o viewer) con accesso al modulo `deviations`.
Restituisce `counts` e `items`. Ogni elemento contiene `kind`,
`id`, `deviation_no`, `title`, `official_status` e `disagreement_days`.
I conteggi misurano segnalazioni. L'elenco comprende tutto il cantiere,
indipendentemente dalla paginazione o dai filtri della vista principale.

I due conteggi sono `closed_without_date` (stato `closed` senza `closed_date`)
e `close_before_approval` (`closed_date` precedente a `approved_date`).
Date uguali sono valide. Una distanza non calcolabile resta `null`.
Gli istanti vengono confrontati conservando i microsecondi; non si attribuisce un
fuso a timestamp che ne sono privi. La distanza è assoluta, in giorni di 24 ore.

Il confronto con uno stato interno è stato ritirato: le deviazioni sono una proiezione dell'import.
Non esiste alcun percorso interno di cambio stato, né API né interfaccia, quindi manca uno stato interno da confrontare.

La vista mostra un pannello richiudibile con due filtri a conteggio e apertura del
dettaglio esistente. Se non ci sono segnalazioni, dichiara l'allineamento delle
cronologie. Il report espone lo stesso risultato nella proprietà `reconciliation`;
la stampa mostra i conteggi
e le prime 10 segnalazioni, ordinate per numero deviazione e ID, con il motivo.
La nota di sola lettura e il perimetro delle date ufficiali compaiono anche nella stampa.

Non sono stati attivati nuovi servizi o applicate modifiche a database operativi.
