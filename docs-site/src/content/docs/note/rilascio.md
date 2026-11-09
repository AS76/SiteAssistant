---
title: Stato del prodotto
description: Cosa è disponibile oggi, cosa manca e quali limiti vanno conosciuti prima dell'uso.
---

Questa pagina descrive la versione attualmente pubblicata. È deliberatamente esplicita su ciò che non esiste, per evitare aspettative sbagliate in cantiere.

## Disponibile nell'interfaccia

- Accesso con email e password, sessioni che durano 7 giorni.
- Richiesta autonoma di accesso e reset password, con approvazione da parte di un owner.
- Ruoli per cantiere: `owner`, `editor`, `verifier`, `viewer`.
- Creazione di cantieri riservata agli owner; codice univoco.
- Attività con esecutore e verificatore separati, priorità, scadenza, area e impresa.
- Transizioni di stato con note e motivazioni, cronologia completa.
- Verifica separata: chi esegue non può chiudere il proprio lavoro.
- Diario per giorno operativo e turno, con piano, consuntivo, impedimenti e prossimo passo.
- Vista **Struttura progetto (WBS)** in sola lettura: albero e tabella piatta.
- Panoramica, bacheca, elenco con filtri, esportazione CSV, stampa del diario.
- Interfaccia italiano/inglese e layout responsive.

## Disponibile solo via API (non nell'interfaccia)

- Gestione dei membri del cantiere.
- Import dello snapshot Time Schedule (WBS) e delle presenze.
- Allegati a attività, diario e cantiere.
- Ripresa di un'attività bloccata e rifiuto di una sottomissione (transizioni non ancora esposte nell'app).

## Non disponibile

- Modifica o eliminazione di cantieri, attività e voci di diario.
- Criteri di accettazione, descrizioni lunghe, checklist.
- Allegati, foto o firme nell'interfaccia.
- Notifiche, calendario, pianificazione e mappe.
- Funzionamento offline o sincronizzazione differita.
- Connettori verso ERP, Primavera P6 o altri sistemi.
- Report PDF generati dal server.

## Limiti da conoscere

- L'evidenza di completamento è una **nota testuale**, non un allegato.
- Esecutore e verificatore sono inseriti come **nomi liberi**, non collegati agli account.
- Le date dei cantieri sono descrittive: non impediscono inserimenti fuori intervallo.
- Il fuso orario e l'ora di taglio sono attributi della singola voce di diario; l'interfaccia usa i valori predefiniti.
- La stampa usa il browser: l'aspetto dipende dal browser e dai margini scelti.
- La lingua traduce l'interfaccia, non i contenuti inseriti.

:::caution[Dati]
La versione attuale è una demo operativa con dati di prova. Non inserire informazioni riservate, credenziali o dati contrattuali.
:::

## Come viene aggiornata questa documentazione

Le pagine vivono nel repository, in `docs-site/`, e vengono pubblicate automaticamente a ogni modifica su `main`. Se una funzione cambia, cambia la pagina che la descrive. Le pagine tradotte in inglese sono mantenute allineate alla versione italiana.
