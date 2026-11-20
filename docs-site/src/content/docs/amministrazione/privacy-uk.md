---
title: Protezione dei dati nel Regno Unito
description: Riferimenti UK GDPR, Data Protection Act e DUAA per installazioni autonome nel Regno Unito.
---

> Riferimento generale, non parere legale né attestazione di conformità UK. La demo pubblica accetta soltanto dati sintetici e non riservati.

## Normativa applicabile

Nel Regno Unito i riferimenti generali includono **UK GDPR**, **Data Protection Act 2018** e **Privacy and Electronic Communications Regulations (PECR)** nei casi pertinenti. Il **Data (Use and Access) Act 2025 (DUAA)** modifica il quadro, senza sostituire il UK GDPR; secondo la guida ICO aggiornata il 19 giugno 2026, tutte le disposizioni del DUAA sulla protezione dei dati erano allora in vigore.

L'autorità britannica di riferimento è l'**Information Commissioner's Office (ICO)**. La lingua inglese, una localizzazione del server nel Regno Unito e il valore tecnico `jurisdiction: UK` non costituiscono una valutazione della legge applicabile. In alcuni scenari possono rilevare anche le regole dell'Unione europea.

## Verifiche da svolgere prima dell'uso reale

| Tema | Valutazione dell'organizzazione |
| --- | --- |
| Controller e processor | Individuare chi determina scopi e mezzi; valutare committente, contractor, amministratori e fornitori. |
| Basi giuridiche e informazioni | Identificare lawful basis, scopi, categorie di dati, informative e diritti delle persone interessate. |
| Workers' health information | I dati relativi alla salute sono special category data; occorre anche una condizione appropriata e salvaguardie specifiche. |
| Contratti e fornitori | Valutare accordi per chi tratta dati per conto del controller; l'autore del solo codice self-hosted non è automaticamente processor. |
| Trasferimenti internazionali | Identificare servizi, accessi e destinatari fuori dal Regno Unito; valutare regole e garanzie applicabili. |
| Conservazione e diritti | Definire periodi, deletion, documentazione e gestione delle richieste anche per copie offline, audit e backup. |
| Sicurezza, DPIA e incidenti | Eseguire valutazione del rischio, verifiche tecniche e DPIA se richiesta; predisporre processi di risposta e comunicazione. |

## Lavoratori, idoneità e cantieri

Il fatto che un Site Manager necessiti di sapere se una persona è autorizzata a svolgere un'attività non significa che debba accedere a diagnosi, referti o dettagli medici. L'ICO invita a limitare la raccolta alle informazioni necessarie, eventualmente alla capacità attuale o futura di svolgere il lavoro, e a valutare specificamente le condizioni per il trattamento di dati sanitari. Il consenso del lavoratore non è di norma una base da scegliere automaticamente per via dello squilibrio nel rapporto di lavoro.

Fotografie, diario, rapporti di incidente, presenze e ore possono identificare lavoratori. L'accesso tecnico di un utente `viewer` non autorizza automaticamente il committente a conoscere tutte le informazioni nominative.

## Limiti di SiteAssistant da tenere presenti

La versione esaminata non include un workflow generale per le richieste di accesso o cancellazione degli interessati, una retention completa per tutte le categorie né permessi per singolo campo. Il trattamento di dati personali reali può richiedere procedure, configurazioni o adattamenti aggiuntivi, soprattutto per allegati, backup, audit e copie offline.

L'AI non è obbligatoria, ma, se configurata, invia domande e record al provider scelto. La valutazione privacy deve coprire anche questo passaggio e gli altri servizi effettivamente attivati.

Completare la [checklist di installazione](../privacy-checklist/) prima di usare dati reali. Non confondere disponibilità del software con autorizzazione al trattamento.

## Fonti ufficiali

- [ICO — What are controllers and processors?](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/controllers-and-processors/controllers-and-processors/what-are-controllers-and-processors/)
- [ICO — The Data (Use and Access) Act 2025 for organisations](https://ico.org.uk/about-the-ico/what-we-do/legislation-we-cover/data-use-and-access-act-2025/the-data-use-and-access-act-2025-what-does-it-mean-for-organisations/)
- [ICO — Workers' health information](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/information-about-workers-health/data-protection-and-workers-health-information/)
- [ICO — Storage limitation](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-principles/a-guide-to-the-data-protection-principles/storage-limitation/)
- [ICO — International transfers](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/international-transfers/a-guide-to-international-transfers/what-is-an-international-transfer-of-personal-information/)
- [Data Protection Act 2018 — legislation.gov.uk](https://www.legislation.gov.uk/ukpga/2018/12/contents)
- [Data (Use and Access) Act 2025 — legislation.gov.uk](https://www.legislation.gov.uk/ukpga/2025/18/contents)

*Riferimenti verificati il 20 novembre 2026. Le autorità possono aggiornare la guida attuativa; verificare prima del deployment.*
