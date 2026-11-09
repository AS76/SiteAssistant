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

## Appartenenze e ruoli

Solo gli **owner** possono aggiungere o rimuovere membri e cambiare ruolo. Un utente vede esclusivamente i cantieri di cui è membro.

Ruoli consigliati in cantiere:

- `owner` al Site Manager e a un secondo responsabile;
- `editor` a capisquadra e supervisori di montaggio;
- `verifier` a qualità/collaudo, separati da chi esegue;
- `viewer` a chi deve solo consultare.

## Il giorno operativo

Fuso orario e ora di taglio determinano a quale giorno operativo appartiene una voce di diario.

| Impostazione | Valore predefinito | Dove si imposta |
| :-- | :-- | :-- |
| Fuso orario | `Europe/Rome` | Attributo della voce di diario (via API) |
| Ora di taglio | `06:00` | Attributo della voce di diario (via API) |

Non sono impostazioni del cantiere e non sono modificabili dall'interfaccia. Le voci già salvate mantengono i valori con cui sono state registrate.

## Cosa non è configurabile

- Logo, colori o dominio per cantiere.
- Campi personalizzati di attività o diario.
- Orari di turno, calendario festivi, notifiche.
