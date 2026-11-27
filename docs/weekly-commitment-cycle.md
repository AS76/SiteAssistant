# Ciclo dell’impegno settimanale

## 1. Problema e casi d’uso

Il giovedì il coordinatore rivede con le squadre gli impedimenti delle prossime settimane e discute il piano della settimana successiva. Ogni squadra conferma il risultato che si impegna a consegnare, con una scadenza e un criterio osservabile. Durante la settimana corrente si registrano i riscontri, si misurano gli impegni rispettati e si ripianifica il lavoro residuo mantenendo traccia della promessa iniziale.

**Stato verificato.** Il programma e le misure di avanzamento contengono date pianificate (`server/migrations/sqlite/036_wbs_operational.sql:17`, `server/migrations/sqlite/036_wbs_operational.sql:93`). Le attività hanno stati operativi e registrano motivo, autore ed evidenza nelle transizioni (`server/repository.mjs:20`, `server/repository.mjs:447`, `server/repository.mjs:498`). La verifica di chiusura di un’attività ammette anche una deroga motivata (`server/repository.mjs:474`). Nel perimetro esaminato queste funzioni non definiscono una promessa di squadra, un piano settimanale congelato o il PPC. Le regole seguenti sono proposte, incluso il calendario della riunione e della pubblicazione.

## 2. Modello

- **Lookahead.** Vista mobile delle prossime 3–6 settimane a partire dalla settimana successiva, con attività candidate, squadra o impresa prevista, finestra di esecuzione, condizioni di prontezza e impedimenti da rimuovere. Le date importate possono alimentare la vista conservando provenienza e snapshot. Una candidatura può diventare proposta esplicita.
- **Settimana corrente.** Intervallo di giorni operativi `[lunedì, lunedì successivo)` nel fuso e con il cutoff del sito, già configurabili (`server/migrations/sqlite/040_site_time_zone.sql:1`, `server/operational-day.mjs:34`). Il coordinatore pubblica il piano discusso giovedì dopo le conferme, al più tardi prima dell’inizio della settimana. Senza pubblicazione la settimana è segnalata come priva di piano misurabile. Alla pubblicazione si fissano calendario, coorte e promesse originarie. La vista distingue esiti e aggiunte operative successive.
- **Impegno.** UUID immutabile, sito, attività di riferimento, autore della proposta, persona che prende la promessa e account che la registra, squadra o impresa responsabile, istante di presa, giorno operativo promesso, risultato, criterio e forma del riscontro richiesto. La scadenza è il cutoff di apertura del giorno operativo seguente, escluso. Data del fatto e istante di registrazione sono distinti. Team, impresa, calendario applicato e criterio sono leggibili storicamente dalle rispettive revisioni o snapshot. Ogni promessa ha un solo responsabile operativo, squadra se designata, altrimenti impresa.
- **Stati.** `proposto` diventa `preso` con conferma attribuita. Da `preso` si passa a `mantenuto` con prova di risultato entro scadenza, a `mancato` dopo scadenza con causa, o ad `annullato` con motivo, attore e data. Una proposta ritirata può essere annullata conservando la traccia. Prima del consolidamento l’assenza di riscontro rimane visibile come esito da chiudere. La chiusura valida atomicamente permesso, stato, sito e prova. Le rettifiche motivate creano revisioni auditate, con validità a fine esclusa. Archiviazione logica, senza eliminazione fisica ordinaria o perdita dell’esito storico.

## 3. PPC

Il denominatore è il numero di UUID distinti nello snapshot pubblicato per la settimana, confermati come presi al momento della pubblicazione e con scadenza nella settimana. Prima della pubblicazione sono esclusi proposte, ritiri e annullamenti. Dopo la pubblicazione la coorte resta fissa, anche se un impegno è annullato con motivo, spostato, archiviato o l’attività cambia data. Un annullato post-pubblicazione conta nel denominatore e vale zero al numeratore. Si espone il numero di questi annullamenti con motivazione. Le promesse aggiunte durante la settimana possono essere gestite e chiuse, con conteggi separati.

Il numeratore è il numero, entro la stessa coorte, di impegni chiusi come mantenuti con riscontro ammesso, che attesta l’intero risultato originario prima della scadenza originaria. Un lavoro finito tardi vale zero anche se in seguito verificato. Un riscontro registrato dopo la scadenza può comprovare un fatto avvenuto in tempo. Un impegno spostato dopo il congelamento riceve un nuovo UUID collegato al precedente. L’originario conserva il suo esito e il nuovo entra solo nella propria coorte se soddisfa i criteri di pubblicazione. Lo stesso fatto può documentare più risultati distinti già definiti nel piano, senza duplicare la stessa consegna.

PPC = 100 × numeratore / denominatore. Con denominatore zero mostrare «non applicabile» con conteggi 0/0. Durante la settimana mostrare PPC provvisorio e numero di esiti aperti, con lo stesso denominatore. Consolidare dopo il termine della settimana quando ogni esito è deciso. In mancanza di un riscontro idoneo, il verificatore registra `mancato` con causa «riscontro insufficiente». Un riscontro valido arrivato dopo il consolidamento richiede rettifica motivata e una nuova versione del PPC. Conservare data, autore, valori e coorte di ogni versione.

L’unità minima è una consegna verificabile attribuita a una squadra o impresa, con un solo esito binario e peso uno. Una quantità può essere parte del criterio, senza frazioni di voto. La serie riporta settimana, versione, frazione, percentuale ed esiti per squadra storica e per cantiere. Gli impegni attribuiti direttamente a imprese confluiscono nel totale di sito e sono visibili come tali. Gli aggregati si calcolano dai conteggi, evitando medie di percentuali. Esempio: 3 mantenuti su 5 per una squadra e 1 su 1 per un’altra danno 4/6 di cantiere.

## 4. Cause del mancato mantenimento

Catalogo proposto con codici stabili ed etichette IT/EN: predecessore incompleto, materiali, mezzi, disponibilità squadra, accesso o permesso, decisione o informazione tecnica, interferenza, condizioni ambientali, cambio di priorità, riscontro insufficiente, causa da accertare, altro. L’ultimo valore richiede una nota. Le revisioni del catalogo conservano gli esiti storici. La squadra propone la causa e il verificatore designato o l’owner la registra alla chiusura, con fonte e motivazione delle correzioni. L’analisi delle ricorrenze guida la rimozione degli impedimenti e può generare azioni con responsabile e scadenza. Nessun punteggio personale o attribuzione automatica di colpa.

## 5. Collegamenti

- Attività interna con UUID e riferimento facoltativo alla fonte di pianificazione stabile. Importazioni e rinnovi del piano preservano la promessa e il riscontro. Le chiusure delle attività e le misure percentuali, quantitative o binarie hanno il proprio ciclo.
- [Diario ed evidenze](evidentiary-diary.md). Collegare la voce o la revisione con il fatto datato, un allegato pertinente oppure un riscontro strutturato e attribuito del verificatore. Il riferimento deve soddisfare il criterio concordato ed essere consultabile secondo i permessi della fonte.
- Impedimenti. Collegare un evento di blocco o una voce di diario con referente, azione e data di rimozione prevista. Se serve un registro dedicato, definirlo a parte. Un impedimento risolto può rendere pronta una proposta.
- [Persone, squadre e imprese](people-and-companies.md) e [luoghi e asset](places-and-assets.md). Applicare identità stabili, perimetro di sito e snapshot pertinenti alla data della promessa o del fatto. Se manca una chiave stabile si conserva il valore originale e si richiede riconciliazione esplicita.

## 6. Permessi

L’editor con accesso al modulo propone e coordina. Un rappresentante autorizzato della squadra o dell’impresa prende l’impegno. Un editor può trascrivere la conferma di una persona senza account, conservando chi ha confermato, la fonte e chi ha registrato. L’owner o l’editor con delega di pubblicazione congela il piano. L’owner o il verifier designato chiude e registra le cause, con separazione tra chi conferma o dichiara l’esecuzione e chi la verifica. Rettifiche consolidate riservate all’owner con motivazione. Le letture seguono sito, membership e autorizzazioni di modulo, inclusi riscontri, conteggi ed export. I ruoli edit/review attuali includono il demo_user (`server/repository.mjs:90`), mentre i moduli nominativi hanno controlli espliciti (`server/module-access.mjs:9`).

Il demo_user vede piani, riscontri e PPC sintetici nei soli siti demo e prova il flusso con ruoli simulati. Nel rilascio iniziale l’accesso leggero segue il perimetro della specifica persone e imprese. Su un’attività condivisa espone esclusivamente i campi pubblicati per quella attività e consente gli eventuali contributi autorizzati. Il piano settimanale, le cause interne, gli aggregati e le azioni ufficiali restano riservati alle sessioni interne autorizzate.

## 7. Criteri di accettazione e test negativi

| Scenario | Risultato atteso |
| --- | --- |
| Giovedì, lookahead con impedimento e conferma per la settimana seguente | La pubblicazione congela criterio, squadra e data. Una modifica all’import lascia invariata la coorte. |
| Chiusura doppia, anche concorrente | Una sola transizione ed effetto sul PPC. Il replay con la stessa chiave restituisce l’esito originale, una seconda transizione distinta riceve conflitto. |
| Mantenuto senza prova, con prova estranea o con completamento al cutoff escluso | Chiusura respinta. L’esito mantenuto è ammesso solo con prova idonea, attribuita e tempestiva. |
| Denominatore zero | PPC non applicabile, 0/0, in UI ed export. |
| Annullamento prima e dopo la pubblicazione, spostamento oltre settimana | Annullamento o spostamento dopo pubblicazione lasciano l’originale nella coorte con zero al numeratore. Il successore è valutato nella sua settimana. |
| Impegno su attività di altro cantiere, anche con doppia membership | Richiesta respinta, nessun legame o effetto aggregato. |
| Cambio di squadra, DST, prova registrata dopo la chiusura della serie | Serie storica ancorata a squadra e calendario originali. Rettifica esplicita per aggiornare una versione consolidata. |
| Demo e link esterno, nelle UI IT e UK | Stessi criteri di calcolo e stessi controlli. Nessuna diffusione di annotazioni o conteggi riservati. |

## 8. Rischi, fuori scope, decisioni per l’owner

Spezzare consegne, rinviare decisioni o congelare il piano tardi può alterare la lettura del PPC. Mostrare coorte, conteggi e variazioni accanto alla percentuale. Fuori scope: riscrittura del planning esterno, ottimizzazione automatica delle risorse, ponderazione per valore o ore, penali e valutazioni individuali.

L’owner deve approvare giorno della riunione e pubblicazione, orizzonte da 3 a 6 settimane, regola proposta sugli annullamenti, soglie e responsabilità di consolidamento, prove ammesse per tipo di consegna, deleghe e catalogo cause. Confini di settimana e formula hanno parità IT/UK, salvo future varianti esplicitamente versionate e visibili in serie.
