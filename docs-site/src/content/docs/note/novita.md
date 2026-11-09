---
title: Novità
description: Modifiche a SiteAssistant che cambiano il prodotto o il modo di usarlo.
---

Questa pagina è mantenuta dal processo automatico di documentazione: quando cambia il comportamento dell'applicazione, qui compare una voce con la data e le pagine aggiornate. Non è un changelog tecnico — per quello vale la cronologia dei commit nel repository.

## 9 novembre 2026

- **Verifica e riapertura riservate.** Solo il verificatore designato o un owner possono chiudere, rifiutare o riaprire un'attività. Chi ha sottomesso il lavoro non può mai verificarlo. Vedi [Attività e verifiche](../../moduli/attivita/).
- **Identità locale con ruoli per cantiere.** Accesso con email e password, sessioni server-side, ruoli `owner`, `editor`, `verifier`, `viewer`. Vedi [Accesso e sessioni](../../guida/accesso/) e [Utenti e ruoli](../../amministrazione/utenti-e-ruoli/).
- **CLI `create-user`.** Provisioning degli account da riga di comando, password mai in argv, assegnazione iniziale a un cantiere. Vedi [Utenti e ruoli](../../amministrazione/utenti-e-ruoli/).
- **Giorno operativo e idempotenza.** Il diario è indicizzato per cantiere, giorno operativo e turno; la creazione attività accetta `Idempotency-Key`. Vedi [Diario di cantiere](../../moduli/diario/) e [API REST](../../riferimento/api/).
- **Pubblicazione del manuale.** Documentazione IT/EN generata dal repository e pubblicata a ogni modifica. Vedi [Stato del prodotto](../rilascio/).

## Come funziona l'aggiornamento

1. Ogni modifica su `main` che tocca `app/`, `server/` o `database/` viene rilevata.
2. Le pagine interessate vengono riviste e aggiornate, in italiano e in inglese.
3. La build controlla i link interni; se qualcosa è rotto, la pubblicazione non passa.
4. La modifica alla documentazione è un commit separato, con etichetta `docs(auto)`.

Se una modifica richiede screenshot o chiarimenti che il processo non può produrre, viene aperta una issue `docs-stale` invece di inventare contenuto.
