---
title: Novità
description: Le modifiche a SiteAssistant che cambiano il prodotto o il modo di usarlo.
---

Questa pagina raccoglie le modifiche visibili a chi usa l'applicazione. Non è un changelog tecnico: per quello vale la cronologia dei commit nel repository.

## 11 novembre 2026

- **Idoneità dei dipendenti.** Nuova vista **Idoneità**, nel gruppo **Gestione** della navigazione: abilitazioni, visite mediche, formazione e altri attestati, con ente o medico, rilascio, scadenza, giorni residui e stato calcolato dalla data — scaduta, in scadenza entro 30 giorni, valida o senza scadenza. Owner ed editor inseriscono, modificano ed eliminano; i verificatori consultano; i viewer non accedono perché sono dati personali. Vedi [Idoneità](../../moduli/idoneita/).
- **Tipo delle attività: ordinaria o correttiva.** Il modulo di creazione ha il campo **Tipo**, la barra dei filtri il menu **Tipo**, le schede correttive il badge **Correttiva** e l'esportazione CSV una colonna **Tipo**. Vedi [Attività e verifiche](../../moduli/attivita/).
- **Limiti e pagine nelle API.** Le richieste a `/api/` sono limitate a 600 al minuto per sessione e a 60 per indirizzo anonimo, con risposta `429` e `Retry-After`; le liste di attività, diario, deviazioni, avanzamento e ore si leggono a pagine con `limit` e `offset`, e il totale arriva nelle intestazioni. Vedi [API REST](../../riferimento/api/).
- **Registro delle attrezzature.** Nuova vista **Attrezzature**, nel gruppo **Gestione** della navigazione: nome, codice o matricola, appaltatore, stato — disponibile, in uso, manutenzione, dismessa — posizione e note, con filtri per appaltatore e stato. Owner, editor e verificatori aggiungono, modificano ed eliminano le righe; i viewer consultano soltanto. Vedi [Attrezzature](../../moduli/attrezzature/).
- **Navigazione desktop raggruppata.** Su desktop le viste sono raccolte in **Operazioni**, **Cantiere** e **Gestione**; le voci e la barra in basso su telefono non cambiano. Vedi [Funzioni comuni](../../guida/funzioni-comuni/#i-gruppi-della-navigazione).
- **Pulsanti coerenti con i ruoli.** Chi ha ruolo `viewer` non vede più **Nuova attività** nella Panoramica e in Attività; **Nuovo cantiere** compare solo agli owner. I controlli del server non cambiano. Vedi [Utenti e ruoli](../../amministrazione/utenti-e-ruoli/).
- **Report del cantiere stampabile.** Il pulsante **Stampa PDF** nella Panoramica e in Avanzamento apre un report con due tabelle — avanzamento per macro-area, con effettivo, pianificato e origine del valore, e deviazioni per macro-area con totale, aperte, chiuse o respinte e conteggio per stato. La stampa usa il browser, in A4 e senza pulsanti. Vedi [Avanzamento di cantiere](../../moduli/avanzamento/#report-del-cantiere).
- **Esportazione CSV del report.** Le due tabelle del report si scaricano come file CSV, con numeri grezzi e celle vuote quando il dato manca. Vedi [Avanzamento di cantiere](../../moduli/avanzamento/#report-del-cantiere).
- **Viste salvate nelle Attività.** Filtri, board o elenco, ordinamento e colonne visibili si salvano con un nome; una vista può essere personale o condivisa con il cantiere e si aggiorna, rinomina o elimina dal menu. Vedi [Attività e verifiche](../../moduli/attivita/#viste-salvate).
- **Codice e descrizione WBS nel dettaglio avanzamento.** Il dettaglio di una voce di avanzamento mostra il nodo collegato come codice seguito dalla descrizione, invece del solo codice. Vedi [Avanzamento di cantiere](../../moduli/avanzamento/#il-dettaglio).

## 10 novembre 2026

- **Import export planning dalla Panoramica.** Owner ed editor caricano un file xlsx, vedono l'anteprima con nuove, aggiornate, invariate, assenti non toccate e rifiutate, poi confermano. Nessuna riga viene cancellata. Vedi [Importare un export di pianificazione](../../amministrazione/import-pianificazione/).
- **Assistente dati.** Il pulsante **AI** in basso a destra apre un pannello con suggerimenti contestuali e risposte con citazioni dei record. Legge i dati del cantiere e non scrive nulla. Vedi [Assistente dati](../../guida/assistente-ai/).
- **Panoramica con contatori e grafici.** Quattro indicatori (deviazioni aperte, ore prenotate, claim aperti, liquidato), ciambella delle deviazioni per stato, avanzamento per sezione con marcatore pianificato e ore per settimana. Vedi [Funzioni comuni](../../guida/funzioni-comuni/).
- **Impostazioni degli importi.** L'ingranaggio in alto a destra imposta valuta, decimali e separatori. Vedi [Impostazioni](../../guida/impostazioni/).
- **Foto e PDF in attività e diario.** Le voci accettano immagini e PDF, anche trascinati dal desktop, fino a 15 MiB per file. Vedi [Diario di cantiere](../../moduli/diario/).
- **Tabelle ordinabili.** Le intestazioni delle tabelle dei moduli ordinano l'elenco; i filtri per colonna sono opzionali e su telefono le tabelle diventano card. Vedi [Funzioni comuni](../../guida/funzioni-comuni/).
- **Navigazione mobile.** Su telefono la barra in basso mostra Panoramica, Attività, Deviazioni, Ore e Altro. Vedi [Guida rapida mobile](../../guida/mobile/).
- **Etichette degli stati dei reclami.** Gli impatti economici usano etichette proprie — Aperto, Notifica inviata, Inviato, Chiuso — invece di quelle delle attività. Vedi [Impatti economici](../../moduli/impatti-economici/).
- **Diario in scrittura per owner, editor e verificatori.** Chi ha ruolo `viewer` consulta il diario ma non vede il pulsante per aggiungere un contributo. Vedi [Diario di cantiere](../../moduli/diario/).
- **Manuale illustrato.** Le procedure hanno passi numerati, immagini con didascalia e cosa fare se qualcosa non riesce; la nuova [Guida rapida mobile](../../guida/mobile/) copre barra in basso, card e bersagli tattili.
- **Bacheche a fisarmonica su telefono.** Attività e Deviazioni mostrano un gruppo per stato alla volta, aperto con un tocco, senza scorrere in orizzontale. Vedi [Guida rapida mobile](../../guida/mobile/).
- **Dettaglio deviazioni a schede.** Il dettaglio separa **Dati** e **Riferimenti**; l'albero della struttura progetto mostra la percentuale di avanzamento accanto a ogni voce. Vedi [Deviazioni](../../moduli/deviazioni/) e [Struttura progetto](../../moduli/wbs/).
- **Password più chiara.** Il modulo di accesso ha il pulsante per mostrare la password; l'avviso di password temporanea si chiude con × per la sessione del browser. Vedi [Accesso e account](../../guida/accesso/).
- **Barra di completamento nei cantieri.** Ogni scheda cantiere mostra la quota di attività chiuse. Vedi [Cantieri](../../moduli/cantieri/).
- **Pesi degli step e storico dell'avanzamento.** I pesi degli step devono sommare 100; ogni registrazione resta in storico e alimenta le curve. Vedi [Avanzamento di cantiere](../../moduli/avanzamento/).
- **Viste dei moduli core.** Deviazioni, Avanzamento, Prenotazioni ore e Impatti economici hanno una vista nell'interfaccia; i dati importati restano in sola lettura, mentre completamento degli step e prenotazione delle ore si registrano dall'applicazione. Vedi [Avanzamento di cantiere](../../moduli/avanzamento/) e [API REST](../../riferimento/api/).
- **Avanzamento, deviazioni e impatti economici via API.** Gli endpoint restituiscono avanzamento e deviazioni importati in sola lettura; gli impatti economici si creano via API e si chiudono con un esito anche dall'interfaccia, collegati alle deviazioni dello stesso cantiere. Vedi [API REST](../../riferimento/api/).
- **Ore prenotate sulle presenze.** Le ore di una presenza possono essere attribuite a una voce di avanzamento; il totale compare nel dettaglio della voce. Vedi [API REST](../../riferimento/api/).
- **Allegati con limiti espliciti.** Attività e diario accettano allegati dall'interfaccia; il cantiere resta via API. Limite **15 MiB**, solo immagini o PDF. Vedi [API REST](../../riferimento/api/).

## 9 novembre 2026

- **Struttura progetto (WBS).** Nuova vista in sola lettura con l'albero e la tabella piatta del Time Schedule importato. Vedi [Struttura progetto](../../moduli/wbs/).
- **Richiesta di accesso autonoma.** Dal modulo di accesso puoi premere **Richiedi accesso** e **Password dimenticata**; l'approvazione avviene da parte di un owner via email. Vedi [Accesso e account](../../guida/accesso/).
- **Cambio password.** Se stai usando una password temporanea, l'applicazione ti invita a cambiarla. Vedi [Accesso e account](../../guida/accesso/).
- **Verifica e riapertura riservate.** Solo il verificatore designato o un owner possono chiudere o riaprire un'attività. Chi ha eseguito il lavoro non può mai verificarlo. Vedi [Attività e verifiche](../../moduli/attivita/).
- **Accesso con ruoli per cantiere.** Accesso con email e password, sessioni che durano 7 giorni, ruoli `owner`, `editor`, `verifier`, `viewer`. Vedi [Utenti e ruoli](../../amministrazione/utenti-e-ruoli/).
- **Giorno operativo.** Il diario è organizzato per cantiere, giorno operativo e turno. Vedi [Diario di cantiere](../../moduli/diario/).
- **Presenze via API.** Le presenze del personale sono disponibili come proiezione in sola lettura via API, non ancora nell'interfaccia. Vedi [API REST](../../riferimento/api/).
- **Manuale rimodellato.** La documentazione è stata riorganizzata per chi usa l'applicazione in cantiere, con guide passo-passo per modulo. Vedi [Stato del prodotto](../rilascio/).

## Come funziona l'aggiornamento

1. Ogni modifica su `main` che tocca `app/`, `server/` o `database/` viene rilevata.
2. Le pagine interessate vengono riviste e aggiornate, in italiano e in inglese.
3. La build controlla i link interni; se qualcosa è rotto, la pubblicazione non passa.
4. La modifica alla documentazione è un commit separato, con etichetta `docs(auto)`.

Se una modifica richiede screenshot o chiarimenti che il processo non può produrre, viene aperta una issue `docs-stale` invece di inventare contenuto.
