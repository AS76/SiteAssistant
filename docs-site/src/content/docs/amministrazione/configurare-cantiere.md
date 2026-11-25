---
title: Configurare un cantiere
description: Codice, date, appartenenze e regole del giorno operativo.
---

Questa pagina raccoglie le impostazioni che riguardano un cantiere e i loro effetti pratici, per chi lo amministra.

## Codice del cantiere

- identificatore breve, univoco, massimo 30 caratteri;
- usato dalla CLI `create-user` per assegnare un utente (`--site`);
- non è modificabile dopo la creazione;
- un codice duplicato viene rifiutato.

Conviene usare un codice stabile nel tempo — per esempio il codice commessa — perché è il riferimento che digitano gli amministratori quando creano gli account.

## Date

Le date di inizio e fine sono **descrittive**: non bloccano l'inserimento di attività o diario fuori intervallo. La data di fine non può precedere quella di inizio.

## Giurisdizione

Ogni cantiere dichiara il diritto che gli si applica: `IT` o `UK`. La giurisdizione appartiene al cantiere, non alla persona e non alla lingua dell'interfaccia.

- Il valore predefinito è `IT`, anche per i cantieri creati prima che il campo esistesse.
- Si indica alla creazione con `POST /api/sites` e si cambia con `PATCH /api/sites/{id}`.
- Il cambio è riservato agli **owner** e lascia una riga nel registro di audit.
- Non è ancora impostabile dall'interfaccia.

## Appartenenze e ruoli

Solo gli **owner** possono aggiungere o rimuovere membri e cambiare ruolo. Un utente vede esclusivamente i cantieri di cui è membro.

Ruoli consigliati in cantiere:

- `owner` al Site Manager e a un secondo responsabile;
- `editor` a capisquadra e supervisori di montaggio;
- `verifier` a qualità/collaudo, separati da chi esegue;
- `viewer` a chi deve solo consultare.

## Il giorno operativo

Fuso orario e ora di taglio del cantiere determinano a quale giorno operativo appartiene una voce di diario.

| Impostazione | Valore predefinito |
| :-- | :-- |
| Fuso orario del cantiere | `Europe/Rome` per `IT`, `Europe/London` per `UK` |
| Inizio del giorno operativo | `06:00` (ora locale) |

I valori iniziali valgono anche per i cantieri già esistenti al momento dell'introduzione di queste impostazioni. Gli **owner** possono modificare entrambi i valori per il cantiere selezionato. Ogni salvataggio viene registrato nell'audit. Le voci di diario già salvate mantengono il fuso e l'ora di taglio registrati alla creazione. Vedi [Impostazioni cantiere](../../guida/impostazioni/#impostazioni-cantiere).

## Assistente dati

Il proprietario può attivare l'assistente per il singolo cantiere e impostare il tempo massimo di risposta. L’assistente è disattivato per impostazione predefinita e il salvataggio delle modifiche viene registrato nell’audit. Vedi [Assistente nelle Impostazioni](../../guida/impostazioni/#assistente).

## Cosa non è configurabile

- Logo, colori o dominio per cantiere.
- Campi personalizzati di attività o diario.
- Ora di inizio del turno notturno, calendario festivi, notifiche.
