# Moduli paese e lingua dei contenuti

## 1. Problema e casi d’uso

Un cantiere italiano e uno britannico devono usare gli stessi flussi per diario, HSE, planning e report, con documenti, ruoli di sicurezza e calendari appropriati al sito. Un operatore può usare l’interfaccia inglese in un cantiere italiano, importare quantità con unità di origine o allegare una prova in un’altra lingua.

**Stato verificato.** La giurisdizione del sito esiste già e accetta IT e UK, con default IT anche nelle migrazioni (`server/migrations/sqlite/028_site_jurisdiction.sql:1`, `server/migrations/pg/028_site_jurisdiction.sql:1`, `server/repository.mjs:153`, `server/repository.mjs:179`). Il fuso e il cutoff sono configurati per sito (`server/migrations/sqlite/040_site_time_zone.sql:1`). Le checklist HSE comprendono già template distinti per giurisdizione, esposti dal server (`server/checklists.mjs:3`, `server/checklists.mjs:54`, `server/http.mjs:560`). Le unità delle righe ordine e package sono testo (`server/migrations/sqlite/032_purchase_orders.sql:22`, `server/migrations/sqlite/033_packages.sql:20`). Le certificazioni usano categorie operative generiche (`server/certifications.mjs:7`). La preferenza valuta è di visualizzazione e vive nel browser (`app/app.mjs:15`, `app/app.mjs:29`). L’interfaccia ha un catalogo IT/EN e formati legati alla lingua. Il modulo data inglese usa mese/giorno, mentre alcune etichette usano en-GB (`app/i18n.mjs:1`, `app/domain.mjs:111`, `app/domain.mjs:116`, `app/app.mjs:133`). Il testo del diario ha campi propri e manca una dichiarazione di lingua nella riga di base (`server/migrations/sqlite/001_init.sql:37`, `server/repository.mjs:573`). Nel perimetro verificato il sostegno al paese è quindi parziale. Calendari, requisiti documentali e lingua dei contenuti richiedono il modello proposto qui sotto.

## 2. Modello

| Dato registrato | Configurazione dichiarativa |
| --- | --- |
| Sito, paese, eventuale territorio, fuso, cutoff e fonte della dichiarazione | Registro versionato dei moduli e dei territori supportati, valori suggeriti e regole generiche di validazione |
| Documento, revisione, lingua dichiarata, autore, dati e allegati originali | Template per tipo, paese, territorio e lingua, campi obbligatori, regole di applicabilità e etichette |
| Nomina o evidenza riferita a persona o impresa, periodo e provenienza | Catalogo di figure e documenti, relazioni ammesse, condizioni, riferimenti ufficiali e stato di approvazione |
| Importi e valuta, valore e unità, dati grezzi, calendario effettivo di sito | Formati accettati, vocabolario delle unità, valute ammesse per campo, calendario territoriale e suggerimenti operativi |

Ogni modulo ha un ID stabile, una revisione immutabile e un intervallo di validità con inizio incluso e fine esclusa. Lo stesso vale per assegnazioni, nomine e configurazioni di sito con effetto nel tempo. Usare archiviazione logica e preservare riferimenti storici e originali senza eliminazione fisica ordinaria. Il documento pubblicato conserva revisione del modulo e del modello, regole applicate, lingua e riferimenti alle fonti. Una modifica futura si applica secondo la data di efficacia e conserva riproducibilità delle edizioni precedenti.

Paese, territorio, locale di presentazione, lingua del testo e fuso sono attributi distinti. IT e UK restano codici applicativi esistenti. La regola documentale si risolve tramite sito, territorio e data di riferimento. La lingua si dichiara all’inserimento o importazione, con tag quali `it` ed `en` e possibilità di tag più specifici per i contenuti, secondo catalogo. Una scelta precompilata richiede conferma. I collegamenti con [diario](evidentiary-diary.md), [persone e imprese](people-and-companies.md) e [luoghi e asset](places-and-assets.md) usano UUID, validità e perimetro del sito.

## 3. Contenuti localizzati

- UI IT/EN selezionabile per profilo. La lingua della UI cambia le etichette, mentre quella di un testo rimane la dichiarazione dell’autore. Etichette mancanti possono avere un fallback esplicitamente configurato per la sola UI. Per un modello documentale richiesto, l’assenza della lingua selezionata blocca la generazione e indica la lacuna.
- Modelli e glossari con chiavi stabili e traduzioni revisionate. Una traduzione è una revisione o variante collegata all’originale, con lingua, autore e provenienza. Le citazioni e gli allegati conservano l’originale con indicazione della lingua quando disponibile. Un documento bilingue richiede un modello esplicitamente abilitato e blocchi con lingua dichiarata.
- Date civili canoniche `YYYY-MM-DD` e istanti con offset esplicito o UTC, mantenendo provenienza e timestamp originari. Formati operativi proposti per IT e UK: giorno/mese/anno, con validazione di calendario. I formati numerici proposti sono `1.234,50` per IT e `1,234.50` per UK. Modulo o profilo d’import deve dichiarare il formato prima di interpretare un valore ambiguo. Nessun secondo tentativo con un formato diverso.
- Importi canonici con decimale e codice valuta esplicito. EUR e GBP sono suggerimenti rispettivamente per IT e UK, da confermare dove il campo li richiede. Il cambio di preferenza modifica la resa, preservando importo e valuta registrati. Quantità con codice unità stabile e valore originale. Unità sconosciute restano da riconciliare. Eventuali conversioni esplicite conservano valore di origine, fattore e unità di destinazione.
- Calendario di sito composto da territorio, festività con fonte, orari/turni, eccezioni locali, fuso e cutoff. Una festività può essere sovrascritta nel calendario operativo con audit. Festività e turni sono date o intervalli locali espliciti, indipendenti dalla lingua scelta.

## 4. Requisiti legali e documentali IT/UK

Questa specifica di prodotto non costituisce consulenza legale. I riferimenti individuano elementi da rappresentare. Figure, applicabilità, firme, adempimenti, conservazione, calendari e testi richiedono validazione del referente HSE e legale competente per territorio prima dell’uso operativo.

| Aspetto | IT | UK |
| --- | --- | --- |
| Figure e incarichi | Rappresentare committente, responsabile dei lavori e coordinatori di progettazione/esecuzione con nomina, periodo e soggetto | Rappresentare client, principal designer, principal contractor e altri soggetti applicabili nel profilo territoriale |
| Fascicoli, piani e responsabilità | Tipi distinti per PSC, POS e fascicolo dell’opera, con livello cantiere o impresa e applicabilità configurata | Tipi distinti per pre-construction information, construction phase plan e health and safety file, ciascuno con titolare, fase e applicabilità |
| Tracciabilità | Gestire fonte, revisione, parti responsabili, stato ed evidenza di consegna, approvazione o notifica dove pertinente | Stesso livello di tracciabilità. Profili distinti per Gran Bretagna e Irlanda del Nord e territorio specifico per il calendario |
| Calendario e documenti operativi | Festività e turni approvati per il sito, vocabolario e modelli IT con disponibilità delle traduzioni previste | Calendari distinti per Inghilterra/Galles, Scozia e Irlanda del Nord, turni approvati per il sito e modelli UK con disponibilità delle traduzioni previste |

I tipi dei documenti e le figure hanno identità proprie per regime. Le analogie operative servono alla navigazione. Per gli obblighi applicabili rappresentare condizioni come fase, tipo di lavoro o presenza di più imprese e registrare la valutazione umana con fonte. Le fonti di partenza sono il [D.Lgs. 81/2008, art. 89](https://www.normattiva.it/atto/caricaDettaglioAtto?atto.articolo.numero=89&atto.articolo.sottoArticolo=1&atto.articolo.tipoArticolo=0&atto.codiceRedazionale=008G0104&atto.dataPubblicazioneGazzetta=2008-04-30), la [guida HSE a CDM 2015](https://www.hse.gov.uk/pubns/priced/l153.pdf), il [quadro HSENI per CDM 2016](https://www.hseni.gov.uk/articles/construction-design-and-management-regulations-northern-ireland-2016) e i [calendari GOV.UK](https://www.gov.uk/bank-holidays).

## 5. Estensibilità a un terzo paese

Il registro deve consentire l’aggiunta di codice paese e territori, locale, calendari, valute e unità, figure, lessico, template, regole di applicabilità e fonti tramite un pacchetto dichiarativo validato e versionato. I moduli funzionali consumano uno schema comune con tipi, condizioni e operazioni note. Il caricamento valida riferimenti, intervalli sovrapposti, chiavi e dipendenze prima dell’attivazione. Nessun codice eseguibile nei pacchetti. Aggiungere un paese entro le capacità già rappresentate richiede il solo pacchetto e la sua attivazione. Nuove capacità di prodotto possono richiedere un’estensione comune del contratto. La proposta presuppone un adeguamento iniziale della validazione e del vincolo IT/UK attuali.

## 6. Migrazione

1. Inventariare dati e fonti in sola lettura. Conservare il valore di giurisdizione esistente e distinguere assegnazione documentata, default storico e provenienza incerta. Anche un IT presente può derivare dal default. Trattare il paese come da confermare quando manca prova. Per UK rilevare anche i territori mancanti.
2. Registrare provenienza e approvazione umana per paese, territorio, lingua e mappature. Un record senza lingua rimane «non dichiarata» finché riconciliato. Preservare testi, originali, nulli, timestamp, unità, valuta eventualmente mancante e snapshot. Il fuso operativo esistente resta applicato finché una modifica viene confermata con decorrenza.
3. Consentire consultazione ed esportazione storica con indicatori di lacuna. Bloccare la pubblicazione di nuovi documenti che richiedono dati dichiarati. Offrire anteprima delle riconciliazioni e un’applicazione idempotente con revisioni e tracciabilità. Il rollback disattiva l’uso delle nuove assegnazioni o applica una rettifica compensativa conservando storico e originali. Migrazione e attivazione operativa sono passaggi distinti.

## 7. Criteri di accettazione e test negativi

| Scenario | Risultato atteso |
| --- | --- |
| UI inglese, sito IT, documento in italiano | Si applica il profilo IT con lingua del documento dichiarata. Cambiare UI preserva risultato, contenuto e metadati. Vale anche per UI italiana e sito UK. |
| Nuovo contenuto senza lingua dichiarata | Pubblicazione respinta con indicazione del campo. Esportazione storica ammessa con stato di provenienza esplicito. |
| Modulo paese o territorio necessario mancante | Pubblicazione dipendente dal profilo bloccata con errore esplicito. Lettura storica conserva i propri riferimenti. |
| Data impossibile, numero in formato estraneo, unità o valuta sconosciuta | Validazione fallisce o import in riconciliazione con originale preservato. La stessa data valida mantiene il significato nelle due UI. |
| Modello IT con campo normativo UK nello stesso documento | Pubblicazione respinta. Una traduzione inglese del documento IT o una citazione UK marcata in allegato è ammessa entro le regole del modello. |
| Modulo aggiornato o archiviato | Il documento già emesso resta riproducibile con la revisione originale. La nuova generazione usa la revisione efficace. |
| Terzo paese e inserimento concorrente di revisioni | Il pacchetto valido si attiva tramite il registro comune. Revisioni incompatibili o sovrapposte sono respinte senza attivazione parziale. |

## 8. Rischi, fuori scope, decisioni per l’owner

Principali rischi: default storici scambiati per dichiarazioni, deriva normativa, ambiguità di import e traduzioni che alterano il lessico tecnico. Fuori scope: consulenza o attestazione automatica di conformità, traduzione automatica con valore ufficiale, invii agli enti, cambio valuta automatico, regole paghe e calendari contrattuali completi.

L’owner deve definire i territori del primo rilascio e i relativi validatori, i documenti prioritari e i dati minimi per ciascun tipo, le lingue pubblicabili, le eccezioni al calendario, chi può dichiarare o rettificare paese e lingua e la gestione del pregresso a provenienza incerta. IT e UK devono avere pari capacità di revisione, tracciabilità e pubblicazione quando i rispettivi moduli sono validati.
