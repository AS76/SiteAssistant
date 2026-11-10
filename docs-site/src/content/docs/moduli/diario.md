---
title: Diario di cantiere
description: Registrare piano e consuntivo del turno, e come funziona il giorno operativo.
---

Il **diario** racconta ogni turno: cosa era previsto, cosa è stato fatto, quali impedimenti sono emersi e cosa passa al turno successivo. È un passaggio di consegne, non un verbale formale.

## Dove si trova

La vista **Diario** mostra le voci del cantiere selezionato per il **giorno operativo** scelto. Da qui si apre il modulo **Aggiungi contributo**.

## Registrare una voce

Dal pulsante **Aggiungi contributo**:

| Campo | Obbligatorio | Note |
| :-- | :-- | :-- |
| Turno | Sì | `day` (diurno) o `night` (notturno) |
| Piano | No | Cosa era previsto per il turno |
| Consuntivo | No | Cosa è stato effettivamente eseguito |
| Impedimenti | No | Blocchi, interferenze, scostamenti |
| Prossimo passo | No | Cosa passa al turno successivo |

Il giorno operativo è calcolato dall'applicazione in base al cantiere e all'orario. Esiste **una sola voce per cantiere, giorno e turno**: un secondo inserimento sulla stessa combinazione viene rifiutato.

## Foto e documenti

Nel modulo **Aggiungi contributo**, il riquadro **Foto o documenti** allega immagini e PDF alla voce:

- trascina i file dal desktop nel riquadro, oppure tocca il riquadro e scegli i file;
- puoi allegare più file;
- ogni file può essere un'immagine o un PDF, fino a **15 MiB**.

Il caricamento degli allegati è riservato a **owner** ed **editor**. I file vengono allegati dopo il salvataggio della voce. Se la voce resta in coda perché sei offline, le foto non vengono allegate: l'applicazione lo segnala e la voce viene salvata comunque. In quel caso allega le foto quando torni online.

Una voce già salvata mostra i suoi allegati e il pulsante **Aggiungi foto o PDF**.

## Il giorno operativo

Il giorno operativo non coincide con la mezzanotte:

- inizia all'ora di taglio configurata, per impostazione predefinita **06:00** nel fuso **Europe/Rome**;
- termina alle 05:59:59 del giorno successivo;
- un turno notturno appartiene al giorno in cui è iniziato.

Esempio: un turno notturno che inizia il 12 novembre alle 22:00 e finisce il 13 alle 06:00 viene registrato sul **12 novembre**.

## Stampa

Il pulsante **Stampa diario** usa la stampa del browser. Non esiste un PDF generato dal server né un archivio delle stampe.

## Cosa non è ancora disponibile

- Modificare o cancellare una voce dopo il salvataggio.
- Collegare una voce di diario a un'attività.
- Rimuovere un allegato dall'interfaccia: la rimozione è disponibile solo via API.
- Chiudere o firmare formalmente il diario: i contributi restano aperti e salvati sul server.
