---
title: Privacy e responsabilità di installazione
description: Distribuzione autonoma, responsabilità sui dati e limiti reali delle funzioni privacy di SiteAssistant.
---

> **Ambito di questa guida.** SiteAssistant è software libero distribuito per installazioni autonome. Questa pagina non è un'informativa privacy dell'organizzazione che lo utilizza, una certificazione di conformità, né consulenza legale. **La demo pubblica deve essere utilizzata soltanto con dati sintetici e non riservati.**

## Un'applicazione utilizzabile in Paesi diversi

SiteAssistant può essere scaricato, installato e adattato secondo la sua licenza [AGPL-3.0-only](https://github.com/AS76/SiteAssistant/blob/main/LICENSE). Il progetto non fornisce, come modello di distribuzione ordinario, un servizio SaaS centralizzato nel quale tutte le aziende devono caricare i propri dati.

Ogni organizzazione che lo adotta deve individuare le norme applicabili al **trattamento concreto** dei dati, valutare configurazione, infrastruttura e fornitori, stabilire finalità e autorizzazioni e predisporre le misure necessarie **prima** di usare dati personali reali. Il software e la licenza non attribuiscono automaticamente una base giuridica al trattamento.

La lingua dell'interfaccia (**IT/EN**), il luogo del server e il campo tecnico `jurisdiction` **non stabiliscono da soli** la legge applicabile. Nella versione esaminata il campo `jurisdiction` ammette soltanto `IT` e `UK` per alcune funzioni applicative: non costituisce una certificazione legale, né un sistema generale di regole per tutti i Paesi. In altri ordinamenti l'organizzazione deve verificare quali funzionalità richiedano adattamento.

## Chi decide e chi tratta i dati

| Situazione | Responsabilità da valutare |
| --- | --- |
| Azienda che installa SiteAssistant e decide perché e come utilizzare i dati | Normalmente agisce da **titolare del trattamento** per quelle finalità, salvo differenti rapporti con altre organizzazioni. |
| Committente, impresa principale e subappaltatori che partecipano allo stesso progetto | Possono essere titolari distinti, contitolari o avere altri ruoli; la matrice tecnica degli accessi non determina il ruolo giuridico. |
| Provider cloud, amministratore esterno o supporto che tratta dati per conto dell'organizzazione | Può essere **responsabile del trattamento**; servono, ove applicabili, istruzioni e accordi conformi alla legge. |
| Autore che pubblica soltanto il codice e non accede ai dati delle installazioni indipendenti | Non è automaticamente responsabile del trattamento dei dati presenti su quelle installazioni. |
| Soggetto che gestisce la demo pubblica o presta separatamente un servizio con dati e accessi propri | Deve valutare le responsabilità relative **a quel servizio**, indipendentemente dalla distribuzione del codice. |

Questi ruoli si valutano in base alle attività effettive, non semplicemente al nome di un contratto, al ruolo `owner` nell'applicazione o alla licenza open source.

## Quali dati possono essere presenti

- **Persone e lavoro:** account, nomi, imprese, qualifiche, presenze, ore, assegnazioni, cronologie e identificativi di chi ha effettuato operazioni.
- **Inviti:** email del destinatario, identità dell'invitante, lingua, eventuali cantiere e ruolo, esiti di invio e registrazioni di audit. Il database conserva l'hash del token. Il link scade dopo 72 ore, mentre i record e l'audit seguono la politica di conservazione dell'installazione.
- **Dati di cantiere:** attività, diario, WBS, avanzamento, deviazioni, HSE, impatti economici e report. I campi liberi possono contenere dati personali anche quando non sono previsti come tali.
- **Dati potenzialmente sanitari:** certificazioni, visite, esiti di idoneità, note o fotografie che rivelino condizioni di salute. Anche un'informazione sintetica di idoneità può richiedere tutele particolari.
- **Copie e metadati:** allegati, esportazioni, backup, dati memorizzati nel browser e operazioni accodate offline. Le sessioni conservano anche indirizzo IP, user-agent e metadati di autenticazione; i registri di audit possono contenere attore, data, valori precedenti e successivi dei record modificati o eliminati e accessi agli allegati HSE. Le copie offline della PWA includono elenchi e metadati degli allegati, **non** i relativi file binari.

Limitare i campi inseriti, gli allegati e le persone autorizzate. Evitare diagnosi, referti e dettagli sanitari nelle note operative salvo che il loro trattamento sia realmente necessario e lecito.

## Dove vanno i dati in un'installazione autonoma

Il database applicativo è **SQLite per impostazione predefinita**, con PostgreSQL come alternativa. Non è previsto un servizio centrale obbligatorio dell'autore né un invio automatico di telemetria o analytics nelle funzioni esaminate. **Questo non significa che ogni funzione sia completamente locale.**

| Componente | Comportamento attuale da considerare |
| --- | --- |
| Database | Dati nell'installazione configurata dall'organizzazione: SQLite o PostgreSQL. |
| Allegati | Richiedono storage oggetti compatibile S3 configurato; nella versione esaminata non c'è un'alternativa automatica su disco. |
| Invio email | Richieste di accesso, recupero password e inviti usano il servizio email configurato. Per gli inviti il servizio riceve l'indirizzo del destinatario e il link monouso. |
| Assistente AI | Funzione opzionale: senza chiave del provider non risponde. Se abilitata, invia domande e risultati delle interrogazioni al servizio LLM. Con la chiave `DEEPSEEK_API_KEY` e senza `ASSISTANT_BASE_URL`, l'endpoint predefinito è **DeepSeek**; un endpoint compatibile può essere configurato, anche auto-ospitato. Per disattivare l'assistente si rimuove la chiave dalla configurazione del server e si riavvia il servizio: non esiste un interruttore nella UI, né per utente o cantiere. |
| Ricerca indirizzi | Quando viene utilizzata, interroga per impostazione predefinita il servizio pubblico **Nominatim** (basato sui dati OpenStreetMap). Con `GOOGLE_MAPS_API_KEY` tenta Google Maps, ma in assenza di risultati o in caso di errore può ricorrere a Nominatim. La versione esaminata non offre un interruttore applicativo dedicato per disattivare tutte le ricerche esterne. |
| Reporting | Può usare un database separato opzionale. |
| Uso offline | Uscire elimina la copia offline, la cache dati del service worker e le modifiche in coda dell’account. L’uscita offline elimina subito i dati locali. La revoca della sessione sul server viene inviata al ritorno della connessione. Sincronizza le modifiche in coda prima di uscire se vuoi conservarle. |

Il soggetto che effettua l'installazione deve censire i fornitori effettivi, localizzazioni, contratti, accessi e trasferimenti. La configurazione della demo pubblica non è una configurazione obbligatoria per le altre installazioni.

## Capacità del prodotto e obblighi dell'organizzazione

I ruoli per cantiere e i permessi per modulo sono strumenti utili, ma **non sostituiscono** la verifica delle autorizzazioni per finalità e categoria di dato. Il ruolo `owner` può accedere a **tutti i moduli del proprio cantiere**, indipendentemente dagli interruttori di accesso ai moduli; questi ultimi non restringono l'owner. Nella versione esaminata non esistono permessi a livello di singolo campo né un sistema completo di workflow per le richieste privacy degli interessati.

Le cancellazioni visibili in alcune schermate non implicano necessariamente la rimozione dei dati da cronologie, audit, esportazioni, backup o dispositivi. **Non è attualmente disponibile una gestione completa e automatica della retention, della cancellazione dei dati personali o dell'esportazione riferita a una persona.** Un'organizzazione che necessiti di tali capacità deve predisporre procedure e interventi tecnici verificati o restringere i dati trattati finché non sono disponibili.

La [checklist di adozione](../privacy-checklist/) aiuta a distinguere i controlli disponibili dalle decisioni e dalle lacune da risolvere.

## Riferimenti per giurisdizione

- [Italia e Unione europea](../privacy-italia-ue/): GDPR UE e quadro italiano.
- [Regno Unito](../privacy-uk/): UK GDPR e normativa britannica.
- **Altri Paesi:** applicare la legge effettivamente pertinente, con verifica locale e senza dedurre conformità dalla presenza della lingua inglese.

## Fonti generali

- [GDPR UE — testo ufficiale](https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=it)
- [EDPB — titolare e responsabile del trattamento](https://www.edpb.europa.eu/sme/learn-the-basics/data-controller-or-data-processor_en)
- [ICO — controller e processor nel UK GDPR](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/controllers-and-processors/controllers-and-processors/what-are-controllers-and-processors/)

*Documento di orientamento; revisione delle fonti: 20 novembre 2026. Versione tecnica di riferimento: commit `9085a5d`. Le capacità descritte dovranno essere verificate di nuovo dopo ogni modifica rilevante del software.*
