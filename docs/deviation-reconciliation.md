# Riconciliazione delle cronologie deviazioni

La riconciliazione elenca anomalie senza modificare date, stati o record. Non richiede migrazioni né nuove dipendenze.

`GET /api/deviations/reconciliation?site_id=<uuid>` richiede un membro del cantiere
(owner, editor, verifier o viewer) con accesso al modulo `deviations`.
Restituisce `counts`, `items` e `history_source`. Ogni elemento contiene `kind`,
`id`, `deviation_no`, `title`, `official_status`, `internal_status`,
`internal_updated_at` e `disagreement_days`. I conteggi misurano segnalazioni:
una deviazione può comparire per più motivi. L'elenco comprende tutto il cantiere,
indipendentemente dalla paginazione o dai filtri della vista principale.

I controlli sulle date ufficiali rilevano chiusure senza data e chiusure precedenti
all'approvazione. Date uguali sono valide. Una distanza non calcolabile resta `null`.
Gli istanti vengono confrontati conservando i microsecondi; non si attribuisce un
fuso a timestamp che ne sono privi. La distanza è assoluta, in giorni di 24 ore;
la soglia di 3 giorni viene applicata prima della formattazione per la visualizzazione.

Il calcolo puro del disaccordo di stato accetta una proiezione esplicita con
`internal_status` e `internal_updated_at`. Sono utilizzabili soltanto le date che
la proiezione applicativa associa esplicitamente a uno stato: `creation_date` per
`open`, `approved_date` per `approved`, `closed_date` per `closed`. Per gli altri
stati manca una data corrispondente nella proiezione: non si usa una data diversa.

**Limite attuale:** `deviations` conserva solo lo stato importato e `created_at`,
senza eventi interni, stato interno distinto o `updated_at`. Le annotazioni
generiche hanno testo libero, senza transizioni strutturate. Gli eventi delle
attività collegate non sono transizioni delle deviazioni. Quindi l'endpoint
restituisce `history_source: "unavailable"`, campi interni `null` e conteggio
`status_gap: 0`. Questo zero **non attesta l'allineamento degli stati**.
Non è possibile nemmeno un'approssimazione con stato e aggiornamento salvati,
perché tali dati interni non esistono. `created_at` non viene usato come sostituto.
Il calcolo del terzo caso è testato su proiezioni sintetiche, ma non è collegato
a una sorgente interna nel servizio attuale.

La vista mostra un pannello richiudibile con tre filtri a conteggio e apertura del
dettaglio esistente. Se non ci sono segnalazioni, dichiara l'allineamento per i
controlli valutabili e rende esplicito il limite dello storico. Il report espone
lo stesso risultato nella proprietà `reconciliation`; la stampa mostra i conteggi
e le prime 10 segnalazioni, ordinate per numero deviazione e ID, con il motivo.
La nota di sola lettura e il limite dello storico compaiono anche nella stampa.

Non sono stati attivati nuovi servizi o applicate modifiche a database operativi.
