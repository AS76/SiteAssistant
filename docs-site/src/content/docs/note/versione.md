---
title: Versione della demo
description: Quale applicazione è distribuita, quale documentazione la descrive e come verificare i due valori.
---

# Versione della demo

Questa pagina rende confrontabili la documentazione che stai leggendo e l’applicazione disponibile sulla demo.

Alla data del **24 novembre 2026**:

| Voce | Valore |
|---|---|
| Commit applicativo | `7c4a851` |
| Asset statici | `siteassistant-v15-54` |
| Schema database | `048` |
| Documentazione aggiornata al commit | `7c4a851` |

## Come verificare

- Aprire `<URL_DEMO>/sw.js` e cercare `siteassistant-v15-54`, dove `<URL_DEMO>` è l’indirizzo della demo fornito dall’operatore.
- Aprire `<URL_API>/api/health`, dove `<URL_API>` è l’URL di base dell’API fornito dall’operatore insieme all’indirizzo della demo: deve rispondere `200` con `"status":"ok"` e `"auth_bypass":false`.
- Aprire la pagina [API REST](../../riferimento/api/) per il contratto pubblico.

Se i valori non coincidono, la demo è stata aggiornata dopo questa pagina: la release più recente prevale. La pagina viene aggiornata al momento della release, senza un nuovo sistema di versionamento.

## Perché è utile

La documentazione descrive un comportamento, non una data. Questo riquadro permette a chi prova la demo di capire subito se sta usando la versione descritta o una successiva, senza aprire il repository.
