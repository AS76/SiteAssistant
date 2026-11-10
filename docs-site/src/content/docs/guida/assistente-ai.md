---
title: Assistente dati
description: Fare domande sui dati del cantiere e aprire i record citati.
---

L'**assistente dati** risponde a domande sui dati del cantiere selezionato. Legge i record e non scrive nulla: le modifiche restano nei moduli, dove le confermi tu.

## Dove si trova

Dopo l'accesso, il pulsante **AI** compare in basso a destra. Aprilo per il pannello **Assistente dati**.

Il pannello contiene:

- la conversazione;
- i suggerimenti per la vista corrente;
- il campo **Chiedi sui dati del cantiere** e il pulsante **Invia**.

Sulla schermata di accesso il pulsante non c'è.

## I suggerimenti

I suggerimenti cambiano con la vista aperta. Alcuni esempi:

- in Panoramica: «Cosa è in ritardo in questo cantiere?»;
- in Attività: «Quante attività sono da verificare?»;
- in Deviazioni: «Quali deviazioni sono ancora aperte?»;
- in Avanzamento: «Quali elementi sono indietro rispetto al piano?»;
- in Prenotazioni ore: «Quante ore sono state prenotate in totale?»;
- in Impatti economici: «Quanto è stato reclamato e quanto liquidato?»;
- in Diario: «Cosa è stato registrato ieri in diario?».

Puoi anche scrivere una domanda tua.

## Le risposte

Le risposte sono brevi e citano i record usati, con il codice tra parentesi quadre: `[DEV-014]`, `[WBS 2.1]`.

Le citazioni sono pulsanti: aprono il dettaglio del record quando quel tipo di record ha un dettaglio nell'interfaccia. Per attività, diario e struttura progetto il riferimento resta un'etichetta.

## La lingua

L'assistente risponde nella lingua dell'interfaccia:

- interfaccia in italiano: risponde in italiano;
- interfaccia in inglese: risponde in inglese.

I codici dei record restano gli stessi.

## Cosa vede

- Solo il **cantiere selezionato**.
- Solo i dati che il tuo ruolo può consultare.
- I record di deviazioni, avanzamento, impatti economici, prenotazioni ore, attività, diario e struttura progetto.

Non vede altri cantieri e non legge il contenuto di foto e PDF.

## Cosa non fa

- **Non scrive**: non crea, non modifica e non chiude record. Se chiedi una modifica, indica la schermata da usare.
- **Non inventa**: se un dato non c'è, risponde che non risulta nei dati.
- **Non calcola totali che non ha interrogato**: i numeri delle risposte arrivano dalle query sui dati.

## Limiti pratici

- Serve la connessione: le domande passano dal server.
- La conversazione resta finché la pagina è aperta; ricaricando si riparte da zero.
- Se l'assistente non è configurato sul server, il pannello mostra un errore.
- Le domande e i record restituiti vengono inviati al provider del modello configurato sul server. Non inserire dati riservati.

Per l'elenco degli endpoint vedi [API REST](../../riferimento/api/).
