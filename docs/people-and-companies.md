# Specifica di persone, imprese e squadre

Stato: proposta da approvare. I riferimenti al codice descrivono la base `8d717cb`. Le regole dei nuovi flussi sono requisiti proposti. Le ipotesi da convalidare sono in §9.

## 1. Problema e casi d’uso reali

L’attività richiede i nomi testuali di esecutore e verificatore e può avere i rispettivi ID di account. Quando presenti, gli ID devono appartenere a membri attivi del sito con ruoli compatibili. Un nome libero evita di creare un account per un operatore esterno, ma lascia irrisolta la sua identità tra schede diverse. Il flusso di accettazione usa l’ID dell’account del verificatore designato, con eccezione per l’owner. (`server/repository.mjs:360–412`, `server/repository.mjs:505–514`)

- Un subappaltatore riceve un link per fotografare un intervento. Può inviare le immagini e proporre uno stato per la scheda indicata. Il responsabile interno valuta il contributo e il verificatore autorizzato decide l’esito.
- Un ispettore esterno esegue un sopralluogo. Un operatore interno registra l’ispettore come autore materiale, con l’impresa di appartenenza alla data del sopralluogo. L’account che registra l’esito resta tracciato.
- Un fornitore consegna materiali. L’ordine identifica l’impresa e la consegna può indicare il referente presente. Una foto esterna eventualmente richiesta documenta la consegna e resta soggetta a riscontro interno.
- Una squadra cambia capo durante il lavoro. Il nuovo capo compare sulle nuove assegnazioni dalla data di decorrenza. I rapporti precedenti continuano a mostrare chi guidava la squadra al momento del fatto.

## 2. Modello di persona, impresa e squadra

Seguire i principi di [luoghi e asset](places-and-assets.md#2-modello-dei-luoghi). Usare UUID immutabili, riferimenti vincolati al sito, archiviazione logica e storico delle modifiche. Il modello minimo assume registri per sito. Un collegamento tra cantieri richiederebbe una futura decisione esplicita.

| Entità | Dati e vincoli proposti |
| --- | --- |
| Persona | UUID, sito, nome visualizzato, eventuali componenti del nome, contatti operativi facoltativi, lingua IT/EN facoltativa, stato e metadati. Il nome e i contatti possono cambiare o essere condivisi. Usarli solo come indizi di riconciliazione. |
| Impresa | UUID, sito, ragione sociale, identificativi fiscali facoltativi con giurisdizione, tipo, valore originale e valore canonico. Ruoli verso il sito, ad esempio appaltatore, subappaltatore, organismo di ispezione o fornitore, con validità temporale. Applicare unicità agli identificativi confermati secondo regole approvate per giurisdizione, conservando gli alias storici. |
| Affiliazione | Persona e impresa dello stesso sito, relazione dichiarata, intervallo di validità e fonte. Più relazioni possono coesistere. Chi registra il fatto indica quella pertinente. |
| Squadra e appartenenza | Squadra con UUID, denominazione e impresa referente facoltativa. Appartenenza con persona, squadra, ruolo e intervallo di validità. Un cambio capo chiude il mandato precedente e apre quello nuovo nella stessa transazione. Nel modello minimo gli intervalli dei capi della stessa squadra non si sovrappongono. |
| Collegamento ad account | Relazione esplicita, facoltativa e tracciata tra persona del sito e account. Al massimo un collegamento attivo per persona e uno per account nello stesso sito. Conferma dell’owner e verifica dell’appartenenza attiva al sito per un nuovo collegamento. |

Usare intervalli con inizio incluso e fine esclusa. Registrare autore, istante, motivo e valori precedenti. Gli alias di import qualificano la chiave con sito e namespace della fonte, conservando valore originale e validità. La correzione di una chiave mantiene la storia e impedisce che un alias già assegnato sia riutilizzato in modo silenzioso. Le relazioni tra record includono il sito nelle chiavi di riferimento.

Un operatore autorizzato seleziona o registra una persona anche senza email e la collega a una partecipazione con ruolo, data, eventuale impresa o squadra e fonte. Il fatto conserva l’UUID e l’etichetta registrata all’epoca. L’audit identifica separatamente l’account che registra il fatto. Un contributo via link identifica invece il link, l’eventuale destinatario dichiarato e il canale di acquisizione. Il possesso del link non prova l’identità di chi lo usa.

## 3. Ruoli operativi e permessi applicativi

| Ruolo operativo | Partecipazione registrabile |
| --- | --- |
| Esecutore | Persona incaricata di eseguire il lavoro, con eventuale squadra e impresa di riferimento. |
| Verificatore | Persona designata per il riscontro, distinta dall’esecutore. Un riscontro esterno documentato può essere acquisito come evidenza. |
| Capo squadra | Persona responsabile della squadra per un intervallo. L’incarico datato resta consultabile dopo la sostituzione. |
| Ispettore | Persona che svolge l’ispezione, con eventuale impresa e qualifica dichiarata. |
| Fornitore | Impresa che fornisce beni o servizi, con una persona facoltativa come referente o addetto alla consegna. |

I ruoli applicativi restano `owner`, `editor`, `verifier`, `viewer` e `demo_user`. Il server legge il ruolo dalla membership accessibile e i moduli applicano i loro controlli, tra cui `workforce_names` per l’accesso nominativo HR. (`server/repository.mjs:90–102`, `server/hr.mjs:40–59`, `server/migrations/pg/051_demo_user.sql:4–6`)

Nel minimo proposto l’owner cura anagrafiche, legami con account, riconciliazione e archiviazione. L’editor può selezionare persone e imprese e registrare la loro partecipazione dove ha accesso in scrittura. Il verifier usa le azioni di verifica previste dal modulo e le condizioni di designazione esistenti. Il viewer consulta le sole proiezioni consentite dai suoi moduli. Il demo_user opera nel perimetro demo con dati sintetici e flussi esterni disabilitati nel rilascio iniziale. Le ricerche per assegnazione espongono solo etichette operative e affiliazioni pertinenti. L’accesso ai dati HR e accesso ai contatti restano controlli espliciti.

La designazione operativa non conferisce una membership. Per le azioni riservate si controllano account, sito, modulo, ruolo e designazione applicabile. Se il verificatore operativo è senza account, è possibile acquisirne il riscontro come evidenza e l’owner può esercitare la facoltà di accettazione già prevista. La separazione tra esecutore e verificatore si controlla anche quando uno è indicato tramite account collegato e l’altro tramite UUID della persona. Una persona senza account può figurare nei record, far registrare il proprio intervento da un operatore interno e inviare i contributi espressamente autorizzati dal link.

## 4. Accesso esterno leggero

Il link concede accesso a un sito e a un solo oggetto esplicitamente condiviso: un’attività, una richiesta di foto legata a un record oppure una pubblicazione di punch list con voci selezionate. Prima dell’emissione, l’operatore vede esattamente il contenuto condiviso, le azioni autorizzate e la scadenza. Il destinatario vede un titolo pubblico, le istruzioni, lo stato pubblico corrente e le voci pubblicate pertinenti. Può caricare foto e proporre uno stato o segnare una voce come pronta al riscontro solo se autorizzato. Questi contributi entrano in una coda interna con esito tracciato. Chiusura, verifica, riapertura e aggiornamento dello stato ufficiale restano nel flusso autenticato.

La risposta esterna usa un elenco esplicito di campi. Diario, HR, contatti, membri, prezzi, ordini completi, annotazioni interne, esiti HSE riservati, altri record e allegati preesistenti restano fuori da tale elenco. Nessuna ricerca o lista generale del sito, inclusi conteggi e suggerimenti. Il link non crea un account, una membership o una sessione applicativa. Le attuali invitations hanno un proprio flusso di consumo con sito e ruolo, documentato in `server/invitations.mjs:76–79` e `server/invitations.mjs:166–183`.

- **Segreto e scadenza.** Token opaco generato con almeno 256 bit casuali. Conservarne solo il digest. Usare HTTPS e scambiare il token con una credenziale separata, limitata allo stesso link e con durata residua al massimo pari a quella del link. Proposta: token nel frammento URL, riscatto via POST dalla pagina dedicata e rimozione del frammento dalla cronologia corrente. Cookie dedicato `HttpOnly`, `Secure`, `SameSite`, vincolato alla superficie esterna. Controllo di origine e difesa CSRF per le scritture. Nessun token in URL di richiesta, log, referrer o telemetria. Pagina senza script di terzi e risposte con `Cache-Control: no-store`, fuori dalla cache PWA.
- **Perimetro e revoca.** A ogni richiesta verificare scadenza assoluta lato server, revoca, sito, tipo e ID dell’oggetto, elenco delle voci e azione concessa. Rigettare anche il target non più condivisibile. La revoca ha effetto anche sulle credenziali già emesse. Serializzare la revoca con la pubblicazione del contributo e ricontrollare il perimetro prima del commit dopo un upload. Un ampliamento del perimetro richiede una nuova emissione esplicita.
- **Abusi e risposte.** Limitare i tentativi per origine di rete anche con token sconosciuto e, per link valido, frequenza e volume cumulativo per link e sito. Applicare limiti prima di accettare i file e coordinare le quote tra istanze. Rispondere con lo stesso `404`, corpo generico e comportamento comparabile a token assente, sconosciuto, scaduto, revocato, sito errato o oggetto fuori scope. Restituire `429` con attesa per i limiti di frequenza senza indicare la validità del link. Una capacità valida sul target richiesto con azione riservata riceve `403`.
- **Foto e registrazione.** Accettare formati raster approvati, validare il contenuto effettivo, limitare dimensioni e numero, rimuovere i metadati sensibili dalle anteprime e tenere gli upload privati fino alla convalida. Conservare l’originale secondo la politica approvata. Ogni invio ha una chiave di idempotenza per link e target. Errori di storage o revoca in corso di invio lasciano la foto indisponibile e il tentativo tracciato, con pulizia degli oggetti non referenziati. Registrare emissione, revoca, tentativi di accesso, letture e invii con istante, esito, ID interno del link e sito/target quando risolti, e account emittente o responsabile della revoca. I log sono ad accesso ristretto e soggetti a conservazione limitata. Escludere segreti, file e testo dei contributi dal log di accesso.

## 5. Collegamenti con i moduli esistenti

Le partecipazioni e le attribuzioni usano riferimenti tipizzati per modulo, con sito, ID del record e ruolo. Le schede trasversali rispettano i permessi del modulo sorgente, anche per ricerche, conteggi e download. Dove applicabile, le evidenze mantengono i riferimenti a luogo e asset secondo la [relativa specifica](places-and-assets.md#4-collegamenti-con-i-moduli).

| Modulo | Stato attuale verificato e integrazione proposta |
| --- | --- |
| Attività | Conserva nomi e ID account facoltativi (`server/repository.mjs:364–412`). Aggiungere esecutore e verificatore operativi, eventuale impresa o squadra e snapshot di assegnazione. L’account designato resta il riferimento di autorizzazione. Registrare esplicitamente riassegnazioni e variazioni di account. |
| Difetti e punch list | Nessun modulo dedicato individuato nella base esaminata. Le deviazioni hanno un proprio flusso (`server/http.mjs:867–904`). Quando esisterà il modulo difetti, aggiungere segnalante, incaricato del ripristino e verificatore con permessi specifici. Una pubblicazione di punch list condivide soltanto le voci selezionate. Nessuna conversione automatica dalle deviazioni. |
| Ispezioni | `performed_by` e `performer_role` sono testi con modalità interna o esterna. Il salvataggio richiede accesso HSE (`server/hse-inspections.mjs:88–112`, `server/hse-inspections.mjs:125–132`). Collegare ispettore e impresa con snapshot alla data. La registrazione e l’esito restano nel modulo HSE. |
| Procurement | L’ordine salva `supplier_name` in chiaro (`server/purchase-orders.mjs:166–189`). I collegamenti di spedizione alle righe verificano la relazione con l’ordine (`server/shipments.mjs:163–167`). Collegare l’impresa fornitrice all’ordine e, alla consegna, l’eventuale referente esplicito. Preservare la denominazione dell’ordine e mantenere distinti referente, vettore e fornitore. |
| Personale e import | La promozione HR genera gli ID employees da sito e matricola e sostituisce la proiezione selezionata con i relativi giorni di lavoro (`server/hr.mjs:146–206`). Tenere una riconciliazione locale verso persona, impresa e squadra. I record importati, le giornate e i relativi permessi continuano a seguire il flusso HR. |
| Allegati | Oggi il server risolve il sito dall’entità proprietaria, controlla ruolo e modulo e rimuove il riferimento allo storage dai metadati pubblici (`server/repository.mjs:679–709`, `server/repository.mjs:732–758`). Riutilizzare lo storage privato e mantenere l’entità proprietaria. Dopo l’approvazione associare l’allegato ordinario al record e mantenere la provenienza esterna, senza simulare l’autore come account interno. |

L’archiviazione esclude persona, impresa e squadra dai nuovi incarichi e chiude le relazioni attive pertinenti alla decorrenza, mantenendo consultabili UUID, snapshot e intervalli conclusi. Prima dell’archiviazione mostrare attività aperte, relazioni e link interessati. Richiedere una riassegnazione esplicita per incarichi correnti indispensabili a completare un’attività, oppure bloccare l’archiviazione con `409`. La riassegnazione non riscrive i fatti già registrati. Revocare nella stessa operazione i link attivi emessi per il destinatario archiviato o per una partecipazione che viene chiusa. Un’impresa archiviata non archivia automaticamente le persone affiliate. Gli account e le membership seguono il loro normale ciclo di autorizzazione. Nessuna eliminazione fisica ordinaria, né cascata su attività, ordini, ispezioni o file.

## 6. Migrazione, riconciliazione e rollback

1. Inventariare per sito i record con ID account, i testi senza ID, le righe `employees` e le relative fonti. Conservare testi originali, null, ID, metadati di origine, storico e allegati. Mantenere compatibili i campi e le API già in uso. Identificare separatamente ogni occorrenza libera con sito, record, campo e revisione di origine.
2. Aggiungere in futuro lo schema in una coppia di migrazioni additive per SQLite e PostgreSQL. Conservare i legami locali e gli alias fuori dalla proiezione sostituibile. La presenza di una migrazione nel repository non attesta la sua applicazione in un ambiente.
3. Generare un’anteprima senza scritture. Usare ID account esistenti come prova del collegamento storico al record. Per HR usare fonte e matricola solo se il namespace è confermato e il codice è stabile in quel perimetro. Una matricola riutilizzata, un account disattivato, omonimie, ragioni sociali simili, più candidati o assenza di ID richiedono decisione esplicita. Un nome coincidente genera solo un suggerimento. Un account storico può restare visibile nel record senza creare un collegamento attivo.
4. Il revisore autorizzato conferma un legame, crea un nuovo record oppure lascia l’occorrenza irrisolta con motivo. I casi irrisolti mostrano il testo di origine. Salva per ciascuna scelta fonte, valore, regola, attore, revisione di origine e UUID risultante. Nessun collegamento tra siti. Applica lotti transazionali, idempotenti e riprendibili. Rifiuta le decisioni su revisioni cambiate dall’anteprima e preserva le modifiche manuali. Confronta copertura, irrisolti, conflitti e valori storici prima e dopo ogni lotto.
5. Attivare per sito dopo una verifica su dati sintetici e approvazione del lotto. Le successive promozioni HR mantengono la riconciliazione confermata e segnalano cambi di identità o scomparse. La scomparsa dalla proiezione non archivia la persona. Preservare le evidenze secondo la politica di conservazione applicabile, mantenendo nel registro di migrazione solo i riferimenti e i valori necessari.
6. Per il rollback disabilitare i nuovi flussi e revocare i link del sito, ripristinando la lettura compatibile dei campi legacy. Annullare solo i legami creati dal lotto e rimasti alla revisione applicata, con un evento compensativo. Segnalare per correzione manuale i conflitti e le nuove dipendenze. Preservare registro delle decisioni, originali, nuove scritture e allegati. Gli ID già referenziati restano risolvibili. Provare anche il riavvio della migrazione dopo il rollback.

## 7. API e schermate minime

Contratti proposti. Per le API interne il prefisso è `/api/sites/:siteId`. Ogni operazione controlla appartenenza, ruolo e modulo. Usare revisione per le mutazioni concorrenti e idempotenza per operazioni ritentabili.

| Contratto | Operazione |
| --- | --- |
| `GET/POST /people`, `/companies`, `/teams` | Ricerca paginata per etichetta e creazione. Esporre contatti e identificativi fiscali solo ai profili autorizzati. |
| `GET/PATCH /people/:id`, `/companies/:id`, `/teams/:id`; `POST /<registro>/:id/archive` | Dettaglio, aggiornamento e archiviazione motivata con dipendenze. Scritture datate per affiliazioni, appartenenze e collegamento account. |
| Mutazioni dei moduli | Aggiungere ID operativi facoltativi e restituire etichetta registrata e stato di archivio. Lasciare i campi testuali e le autorizzazioni applicative compatibili. |
| `POST /people-reconciliation/previews`, `POST /people-reconciliation/batches` | Anteprima, approvazione di decisioni e applicazione tracciata. Consentire consultazione del lotto e rollback compensativo all’owner. |
| `GET/POST /external-links`, `POST /external-links/:id/revoke` | Elenco interno con metadati, emissione con restituzione del segreto una volta sola e revoca. |
| `GET /external-contributions`, `POST /external-contributions/:id/review` | Coda interna filtrata per modulo e revisione con esito e motivazione. |
| `POST /api/external/redeem`, `GET /api/external/sites/:siteId/shared/:id`, `POST /api/external/sites/:siteId/shared/:id/contributions` | Riscatto, proiezione pubblicata e invio di contributi. La credenziale esterna identifica il link e l’ID indica l’oggetto condiviso. Il client non sceglie entità proprietaria né autore dell’allegato. |

Schermate minime: registro filtrabile e schede con storico e dipendenze; selettore nelle attività e nei moduli abilitati con etichette per riferimenti archiviati; coda di riconciliazione con affiancamento dell’originale; pannello di condivisione con anteprima, scadenza e revoca; pagina mobile IT/EN per consultazione e invio; coda interna per accettare o respingere contributi. La punch list si abilita quando il suo modulo dispone di ID stabili, permessi e pubblicazione selettiva.

## 8. Criteri di accettazione e test negativi

| Scenario | Esito verificabile |
| --- | --- |
| Persona senza account | Un editor abilitato la registra come partecipante. Nessun nuovo account o membership. L’audit distingue partecipante e operatore autenticato. |
| Stessa persona tramite riferimenti diversi | Una designazione come esecutore tramite account e come verificatore tramite la persona collegata viene respinta senza scritture. |
| Cambio capo squadra | Gli intervalli sono contigui alla decorrenza. Rapporti precedenti e successivi mostrano i riferimenti corretti. Un cambio concorrente non crea due capi attivi. |
| Link valido | Il destinatario vede solo i campi pubblicati e invia una foto autorizzata. Ripetere la stessa richiesta produce un singolo contributo. Lo stato ufficiale resta invariato fino al flusso interno. |
| Scadenza e revoca | Al raggiungimento della scadenza o dopo revoca, riscatto, letture e scritture restituiscono il medesimo `404` previsto per un link sconosciuto, anche con cookie già emesso. |
| Link su altro sito o altra voce | Sostituendo sito, oggetto o voce nella richiesta si ottiene `404` senza metadati, effetti, URL di file o indicazioni sull’esistenza del record. |
| Azione riservata senza account | Una verifica richiesta sulla superficie esterna con capacità valida restituisce `403`. Il cookie esterno inviato da solo alle API ordinarie non autentica l’utente. Stato e audit di dominio non riportano alcuna verifica eseguita. |
| Foto non valida e limiti | Tipo dichiarato e contenuto discordanti sono respinti. Oltre soglia il servizio restituisce `429` per la frequenza. Quote e dimensioni bloccano la scrittura prima della pubblicazione. Nessun oggetto fallito è consultabile. |
| Revoca durante upload | Se la revoca precede il commit del contributo, nessuna foto è pubblicata e lo storage viene ripulito. Il log conserva l’esito senza token. |
| Persona o impresa archiviata | Un’attività storica conserva ID ed etichetta, con stato archiviato visibile. I selettori e le nuove assegnazioni escludono il record. Una dipendenza operativa indispensabile richiede riassegnazione o produce `409`. |
| Import ambiguo, ripetizione e rollback | Omonimi e matricole riciclate restano irrisolti, con testo originale visibile. Una seconda applicazione non duplica legami. Il rollback conserva campi, allegati e correzioni manuali e lascia audit consultabile. |
| Permessi trasversali | Un profilo privo di `workforce_names` non recupera righe nominative HR, giornate o aggregati riservati attraverso registro, ricerca o export. Il test si applica anche a demo_user. |

Eseguire in fase di implementazione i test di sito, vincoli, concorrenza e rollback in entrambi i database. Verificare in browser la pagina esterna, la revoca dopo il riscatto e l’assenza di contenuti riservati dalla cache offline.

## 9. Rischi, fuori scope e decisioni dell’owner

I rischi principali sono attribuzioni errate dopo un import, diffusione per inoltro dei link, acquisizione di foto sensibili, esposizione indiretta dei dati HR e perdita del contesto storico a seguito di una riassegnazione. L’anteprima con conferma, il perimetro esplicito, i limiti di durata e gli snapshot affrontano questi rischi. Un link inoltrato può essere usato da chi lo riceve fino a scadenza o revoca.

Fuori scope: anagrafica globale tra cantieri, sincronizzazione in scrittura verso le fonti, sostituzione della proiezione HR, verifica d’identità, firma o attestazione legale, onboarding automatico di account e conversione delle deviazioni in difetti.

| Decisione da approvare | Ipotesi per il minimo |
| --- | --- |
| Chi emette e revoca link | Solo owner del sito per il lancio. Valutare delega esplicita e revocabile a editor con permesso dedicato e modulo abilitato. L’owner può revocare qualsiasi link del sito. Confermare revoca automatica alla perdita del diritto di condivisione dell’emittente. Fino all’approvazione il flusso resta disabilitato. |
| Durata, riuso e distribuzione | Proposta di 24 ore predefinite e massimo 72 ore, riducibili dal sito. Nessun rinnovo implicito. Un link può servire per più contributi entro quota. Primo invio manuale da parte dell’emittente. Confermare se alcuni casi richiedono riscatto singolo o un secondo fattore. |
| Pubblicazione esterna | Confermare campi, stati proposti e moduli ammessi, chi convalida l’invio e condizioni di condivisione delle evidenze di consegna o ispezione. Foto e stato di attività come prima fase. Punch list subordinata al modulo dedicato. |
| Protezione dei dati e soglie | Approvare accesso a contatti e identificativi fiscali, eventi registrati, tempi di conservazione, eventuali dati di rete, limiti per file e per link e regole per originali e metadati. |
| Identità e riconciliazione | Confermare registro per sito, fonti affidabili, regole di canonizzazione fiscale, perimetro della matricola, gestione dei duplicati e unicità del capo squadra. Approvare revisori e criteri di attivazione e rollback per sito. |
