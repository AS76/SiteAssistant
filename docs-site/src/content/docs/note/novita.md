---
title: Novità
description: Le modifiche a SiteAssistant che cambiano il prodotto o il modo di usarlo.
---

Questa pagina raccoglie le modifiche visibili a chi usa l'applicazione. Non è un changelog tecnico: per quello vale la cronologia dei commit nel repository.

## 9 novembre 2026

- **Struttura progetto (WBS).** Nuova vista in sola lettura con l'albero e la tabella piatta del Time Schedule importato. Vedi [Struttura progetto](../../moduli/wbs/).
- **Richiesta di accesso autonoma.** Dal modulo di accesso puoi premere **Richiedi accesso** e **Password dimenticata**; l'approvazione avviene da parte di un owner via email. Vedi [Accesso e account](../../guida/accesso/).
- **Cambio password.** Se stai usando una password temporanea, l'applicazione ti invita a cambiarla. Vedi [Accesso e account](../../guida/accesso/).
- **Verifica e riapertura riservate.** Solo il verificatore designato o un owner possono chiudere o riaprire un'attività. Chi ha eseguito il lavoro non può mai verificarlo. Vedi [Attività e verifiche](../../moduli/attivita/).
- **Accesso con ruoli per cantiere.** Accesso con email e password, sessioni che durano 7 giorni, ruoli `owner`, `editor`, `verifier`, `viewer`. Vedi [Utenti e ruoli](../../amministrazione/utenti-e-ruoli/).
- **Giorno operativo.** Il diario è organizzato per cantiere, giorno operativo e turno. Vedi [Diario di cantiere](../../moduli/diario/).
- **Presenze e allegati via API.** Le presenze del personale e gli allegati sono disponibili come proiezioni in sola lettura via API, non ancora nell'interfaccia. Vedi [API REST](../../riferimento/api/).
- **Manuale rimodellato.** La documentazione è stata riorganizzata per chi usa l'applicazione in cantiere, con guide passo-passo per modulo. Vedi [Stato del prodotto](../rilascio/).

## Come funziona l'aggiornamento

1. Ogni modifica su `main` che tocca `app/`, `server/` o `database/` viene rilevata.
2. Le pagine interessate vengono riviste e aggiornate, in italiano e in inglese.
3. La build controlla i link interni; se qualcosa è rotto, la pubblicazione non passa.
4. La modifica alla documentazione è un commit separato, con etichetta `docs(auto)`.

Se una modifica richiede screenshot o chiarimenti che il processo non può produrre, viene aperta una issue `docs-stale` invece di inventare contenuto.
