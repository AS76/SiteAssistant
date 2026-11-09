---
title: Diario di cantiere
description: Come si registra il piano e il consuntivo del turno, e come funziona il giorno operativo.
---

Il **diario** registra, per ogni turno, cosa era previsto, cosa è stato fatto, quali impedimenti sono emersi e cosa passa al turno successivo.

## Dove si trova

La vista **Diario** mostra le voci del cantiere selezionato per la data di rendicontazione corrente. Da qui si apre il modulo **Nuova voce**.

## Campi di una voce

| Campo | Obbligatorio | Note |
| :-- | :-- | :-- |
| Turno | Sì | `day` (diurno) o `night` (notturno) |
| Piano | No | Cosa era previsto per il turno |
| Consuntivo | No | Cosa è stato effettivamente eseguito |
| Impedimenti | No | Blocchi, interferenze, non conformità |
| Prossimo passo | No | Cosa passa al turno successivo |
| Data | Sì | Giorno operativo calcolato dall'applicazione |

Esiste **una sola voce per cantiere, giorno operativo e turno**. Un secondo inserimento sulla stessa combinazione viene rifiutato con `409 DUPLICATE_DIARY`.

## Giorno operativo

Il giorno operativo non coincide con la mezzanotte:

- inizia all'ora di taglio configurata, per impostazione predefinita **06:00** nel fuso **Europe/Rome**;
- termina alle 05:59:59 del giorno successivo;
- un turno notturno appartiene al giorno operativo in cui è iniziato.

Esempio: un turno notturno che inizia il 12 novembre alle 22:00 e finisce il 13 alle 06:00 viene registrato sul **12 novembre**.

Fuso orario e ora di taglio sono attributi della singola voce di diario. L'interfaccia usa i valori predefiniti; per impostarli diversamente bisogna passare dall'API (`time_zone`, `day_cutoff_time`), come descritto in [API REST](../../riferimento/api/).

## Stampa

Il diario si stampa con la finestra di stampa del browser. Non esiste un'anteprima PDF generata dal server né un archivio delle stampe.

## Cosa non è disponibile

- Modifica o cancellazione di una voce dopo il salvataggio.
- Autore della voce diverso dall'utente autenticato.
- Collegamento tra voce di diario e attività.
- Allegati o foto.
