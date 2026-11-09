---
title: Cantieri
description: Creare, selezionare e organizzare i cantieri su cui si lavora.
---

Il **cantiere** è l'unità organizzativa di SiteAssistant. Tutti i dati — attività e diario — appartengono a un cantiere e sono visibili solo ai suoi membri.

## Elenco dei cantieri

La vista **Cantieri** mostra una scheda per ogni cantiere in cui hai un ruolo attivo, con:

- codice e nome;
- ubicazione;
- date di inizio e fine;
- numero di attività totali e ancora aperte.

Il cantiere selezionato è evidenziato. Il pulsante **Apri** imposta il contesto di lavoro; da quel momento Panoramica, Attività e Diario mostrano solo quel cantiere.

## Creare un cantiere

La creazione è riservata a chi ha il ruolo **owner** su almeno un cantiere. Il modulo richiede:

| Campo | Obbligatorio | Note |
| :-- | :-- | :-- |
| Codice | Sì | Univoco, massimo 30 caratteri, usato anche dalla CLI per assegnare gli utenti |
| Nome | Sì | Massimo 120 caratteri |
| Ubicazione | No | Massimo 160 caratteri |
| Data inizio | No | Precompilata con oggi |
| Data fine | No | Non può precedere la data di inizio |

Chi crea il cantiere ne diventa automaticamente **owner**.

Un codice già esistente viene rifiutato con `409 DUPLICATE_SITE_CODE`: non ci sono due cantieri con lo stesso codice.

## Appartenenza e ruoli

L'appartenenza a un cantiere è la relazione tra utente e cantiere, con un ruolo: `owner`, `editor`, `verifier` o `viewer`. Senza appartenenza il cantiere non compare nell'elenco e le relative API rispondono `403`.

La gestione dei membri avviene tramite API (`GET`/`POST /api/sites/{id}/members`), perché in questa versione l'interfaccia non espone una schermata dedicata. Vedi [Utenti e ruoli](../../amministrazione/utenti-e-ruoli/).

## Cosa non è previsto

- Eliminare o archiviare un cantiere dall'interfaccia.
- Modificare un cantiere dopo la creazione (nome, date, ubicazione).
- Gestire i membri da interfaccia.

Queste operazioni non sono disponibili nella versione attuale; non sono "nascoste", semplicemente non esistono.
