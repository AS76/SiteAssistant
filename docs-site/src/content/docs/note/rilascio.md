---
title: Stato del prodotto
description: Cosa è implementato oggi, cosa manca e quali limiti vanno conosciuti prima dell'uso.
---

Questa pagina descrive la versione attualmente pubblicata. È deliberatamente esplicita su ciò che non esiste, per evitare aspettative sbagliate in cantiere.

## Implementato

- Accesso con email e password, sessioni server-side con cookie `sa_session`.
- Ruoli per cantiere: `owner`, `editor`, `verifier`, `viewer`.
- Creazione cantieri riservata agli owner; codice univoco.
- Attività con esecutore e verificatore separati, priorità, scadenza, aree e imprese.
- Transizioni di stato con note e motivazioni, cronologia eventi completa.
- Verifica separata: chi esegue non può chiudere il proprio lavoro.
- Diario per giorno operativo e turno, con piano, consuntivo, impedimenti e prossimo passo.
- Vista panoramica, bacheca, elenco con filtri, esportazione CSV, stampa del diario.
- Interfaccia italiano/inglese e layout responsive.
- API REST documentata, con idempotenza sulla creazione attività.

## Non implementato

- Registrazione autonoma, recupero password, invio email transazionali.
- Modifica o eliminazione di cantieri, attività e voci di diario.
- Allegati, foto, firme o documenti.
- Notifiche, calendario, pianificazione e mappe.
- Funzionamento offline o sincronizzazione differita.
- Connettori verso ERP, Primavera P6 o altri sistemi.
- Gestione membri dall'interfaccia (esiste solo via API).
- Report PDF generati dal server.

## Limiti da conoscere

- L'evidenza di completamento è una **nota testuale**, non un allegato.
- Le date dei cantieri sono descrittive: non impediscono inserimenti fuori intervallo.
- Il fuso orario e l'ora di taglio sono attributi della singola voce di diario; l'interfaccia usa i valori predefiniti.
- La stampa usa il browser: l'aspetto dipende dal browser e dai margini scelti.
- La lingua traduce l'interfaccia, non i contenuti inseriti.
- Non ci sono due cantieri con lo stesso codice.

:::caution[Dati]
La versione attuale è una demo operativa con dati di prova. Non inserire informazioni riservate, credenziali o dati contrattuali. L'accesso al perimetro è protetto da autenticazione applicativa e, sull'istanza demo, da Basic Auth di rete.
:::

## Come viene aggiornata questa documentazione

Le pagine vivono nel repository, in `docs-site/`, e vengono pubblicate automaticamente a ogni modifica su `main`. La revisione dei contenuti segue le release: se una funzione cambia, cambia la pagina che la descrive. Le pagine tradotte in inglese sono mantenute allineate alla versione italiana.
