---
title: Checklist privacy per la messa in esercizio
description: Metodo verificabile per installare SiteAssistant con dati reali, distinguendo controlli attuali, configurazioni e lacune.
---

> **Non è un attestato.** Questa checklist è una traccia di verifica per l'organizzazione che gestisce l'installazione. Non certifica la conformità alla legge. Non caricare dati personali o contrattuali reali nella demo pubblica.

## Come documentare la decisione

Per ciascun controllo registrare **referente, esito, evidenza, data, azione correttiva e approvazione**. Stati suggeriti: *verificato*, *da adeguare*, *non applicabile con motivazione*, *non verificato*. L'assenza di un pulsante nell'applicazione non elimina un obbligo giuridico.

## Prima di utilizzare dati reali

| Ambito | Verifica da effettuare | Evidenza da conservare |
| --- | --- | --- |
| Finalità, titolari e responsabili | Chi stabilisce le finalità? Quali ruoli hanno impresa, committente, subappaltatori e fornitori? | Mappa delle responsabilità e contratti pertinenti. |
| Normative | Quali Paesi e trattamenti sono coinvolti? Possono applicarsi più regole? | Valutazione e fonti normative datate. |
| Inventario | Quali dati sono nei moduli, nei testi liberi, nelle immagini e nei PDF? Quali persone sono identificabili? | Inventario per categoria, fonte e destinatario. |
| Base giuridica e trasparenza | Qual è la base per ciascuna finalità? Esiste l'informativa appropriata? Per eventuali dati sanitari è stata verificata una condizione aggiuntiva? | Registro finalità/basi e informative. |
| Necessità e minimizzazione | È indispensabile registrare nomi, dettagli clinici o fotografie? Si può usare uno stato operativo meno dettagliato? | Regole d'inserimento e minimizzazione per modulo. |
| Ruoli e accessi | La matrice per cantiere/modulo corrisponde alle autorizzazioni effettive? Sono stati verificati profili esterni e proprietari del sito? | Test della matrice autorizzativa, anche sulle esportazioni e sugli allegati. |
| Hosting e servizi | Chi gestisce DB, storage oggetti, email, indirizzi, AI, reporting e backup? Sono obbligatori o opzionali per i moduli in uso? | Diagramma dei flussi e inventario fornitori. |
| Trasferimenti | Quali fornitori o amministratori possono vedere dati dall'estero? | Region, contratti, garanzie e decisione documentata. |
| Conservazione | Quali periodi e cancellazioni si applicano a record, sessioni, audit, allegati, export, cache e backup? | Piano retention con esecuzione e verifica, non solo configurazione. |
| Diritti delle persone | Come identificare, raccogliere, rettificare, limitare o cancellare informazioni che riguardano una persona? | Procedura di richiesta e test su dati di prova. |
| Incidenti e continuità | Come vengono rilevati, comunicati, ripristinati e verificati gli incidenti? | Piano incidenti, log, backup e restore test. |
| DPIA | Il tipo di dati e trattamento richiede valutazione d'impatto? | Screening DPIA e valutazione completa se richiesta. |
| Messa in esercizio | Quali test dimostrano che il sistema reale è configurato come deliberato? | Verbale go/no-go con limitazioni note. |

## Limiti della versione esaminata che non vanno ignorati

**Conservazione.** La manutenzione degli import prevede regole documentate per alcuni payload, ma l'esecuzione della pulizia dipende dalla schedulazione dell'operatore: lo script disponibile **non è automaticamente schedulato**. Non esiste un meccanismo generale di conservazione e cancellazione per tutte le entità applicative, sessioni, audit e copie di backup. Le scadenze della singola installazione devono essere definite e verificabili.

**Cancellazione e richieste privacy.** Alcuni record possono essere rimossi definitivamente; altri vengono nascosti con conservazione nello storico e altri non hanno una funzione di cancellazione/modifica. Non esiste una funzione completa di esportazione per interessato o di cancellazione trasversale a tutte le fonti. Fino a quando tali funzioni non saranno disponibili e testate, occorrono procedure amministrative approvate, valutazione caso per caso delle eccezioni applicabili e, quando necessario, adattamenti tecnici. Non promettere cancellazioni automatiche che l'app non esegue.

**Dispositivi offline.** Uscire elimina la copia offline, la cache dati del service worker e le modifiche in coda dell’account. L’uscita offline elimina subito i dati locali. La revoca della sessione sul server viene inviata al ritorno della connessione. Sincronizza le modifiche in coda prima di uscire se vuoi conservarle.

**Dati sanitari e testi liberi.** Il modulo Idoneità può memorizzare visite, esiti e note; allegati e testi liberi degli altri moduli possono contenere informazioni identificabili o sulla salute. Disabilitare o limitare l'uso di tali dati finché non sono definite basi, necessità, accessi, conservazione e procedure verificabili.

**Accessi.** Il sistema dispone di quattro ruoli fissi e autorizzazioni per modulo, ma il ruolo `owner` del cantiere **non è limitato dagli interruttori dei moduli** e vede tutti i moduli del proprio cantiere. Non ci sono permessi per singolo campo. Verificare in particolare quali persone debbano avere il ruolo `owner`; le autorizzazioni tecniche non equivalgono automaticamente a quelle legali e contrattuali.

**AI e servizi esterni.** L'assistente AI non è necessario all'installazione base. Quando è attivato, invia domande e dati dei record restituiti dai tool al provider del modello; con `DEEPSEEK_API_KEY` e senza `ASSISTANT_BASE_URL`, il predefinito è **DeepSeek**. Può essere impostato un endpoint compatibile diverso. Si disattiva rimuovendo la chiave dalla configurazione del server e riavviando il servizio, **non** mediante un interruttore UI, né per singolo cantiere o utente. Valutare il fornitore, le categorie di dati, lo scopo, i trasferimenti e la conservazione **prima** di abilitarlo con dati personali. SMTP e storage oggetti possono coinvolgere terzi; l'uso della ricerca indirizzi interroga di default **Nominatim** e può ricorrervi anche dopo un tentativo con Google Maps.

**Esportazioni.** Sono disponibili CSV di alcune viste, stampe dal browser e l'esportazione CSV del registro evidenze (`GET /api/sites/{site_id}/evidence-export`), limitata al proprio perimetro di dati e moduli. Nessuna di queste funzioni costituisce un export completo di tutto il cantiere o un'esportazione riferita a una persona.

## Decisione di rilascio

Un'installazione può essere valutata solo in base al **perimetro di dati e funzioni effettivamente utilizzati**. Se una funzione necessaria alla gestione di dati personali non esiste, le alternative sono: limitare i dati o il modulo, introdurre una procedura tecnica verificata, oppure rinviare l'uso reale finché il requisito non è coperto.

Non classificare una lacuna come “conforme perché è responsabilità dell'utente”: le responsabilità dell'organizzazione non trasformano automaticamente in idonea la capacità tecnica del sistema.

## Leggi anche

- [Principi e responsabilità](../privacy-responsabilita/)
- [Riferimenti Italia/UE](../privacy-italia-ue/)
- [Riferimenti UK](../privacy-uk/)
- [Guida all'assistente dati](../../guida/assistente-ai/)

*Metodologia di progetto, versione del 20 novembre 2026; riferimento tecnico `9085a5d`. Consultare un professionista privacy/legale per l'applicazione a specifici trattamenti e ordinamenti.*
