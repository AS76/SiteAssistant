---
title: Cantieri
description: Creare e selezionare i cantieri su cui lavori.
---

Il **cantiere** è il contenitore di tutto il lavoro: attività e diario appartengono sempre a un cantiere e sono visibili solo a chi ne è membro.

## L'elenco dei cantieri

La vista **Cantieri** mostra una scheda per ogni cantiere di cui sei membro, con:

- codice e nome;
- ubicazione;
- date di inizio e fine;
- numero di attività totali e di attività ancora aperte.

Il cantiere selezionato è evidenziato. Il pulsante **Apri** lo imposta come contesto di lavoro: da quel momento Panoramica, Attività, Struttura progetto e Diario mostrano solo quel cantiere.

## Creare un cantiere

Creare un cantiere è riservato a chi ha il ruolo **owner** su almeno un cantiere. Dal pulsante **Nuovo cantiere**:

| Campo | Obbligatorio | Note |
| :-- | :-- | :-- |
| Codice | Sì | Univoco, massimo 30 caratteri; serve anche per assegnare gli utenti |
| Nome | Sì | Massimo 120 caratteri |
| Ubicazione | No | Massimo 160 caratteri |
| Data inizio | No | Già impostata a oggi |
| Data fine | No | Non può precedere la data di inizio |

Chi crea il cantiere ne diventa automaticamente **owner**. Un codice già usato viene rifiutato: non esistono due cantieri con lo stesso codice.

## Ruoli e visibilità

L'appartenenza a un cantiere associa ogni persona a un ruolo: `owner`, `editor`, `verifier` o `viewer`. Senza appartenenza il cantiere non compare nel tuo elenco. I ruoli sono descritti in [Utenti e ruoli](../../amministrazione/utenti-e-ruoli/).

## Cosa non è ancora disponibile

- Eliminare o archiviare un cantiere dall'interfaccia.
- Modificare un cantiere dopo la creazione (nome, date, ubicazione).
- Gestire i membri da una schermata dedicata: in questa versione si fa via API.

Queste operazioni non sono "nascoste": semplicemente non esistono ancora in questa versione.
