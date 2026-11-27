# Specifica del diario di cantiere e delle evidenze

Stato: proposta da approvare. La verifica del codice riguarda la base `8d717cb`. Le regole descritte come requisiti sono proposte. Le ipotesi operative da confermare sono in §10.

## 1. Problema e casi d’uso

Il diario consente di registrare piano, consuntivo, impedimenti e prossimo passo in una voce per sito, giorno operativo e turno. Il server registra l’ora di inserimento, il fuso e il cutoff del sito e l’ID dell’account autore quando disponibile. Accetta registrazioni retroattive con regole di ruolo e motivazione oltre sette giorni. Le rettifiche archiviano lo snapshot precedente, l’account che corregge, l’istante e il motivo, poi aggiornano la riga corrente. Il client può consultare le versioni. Lo schema e le azioni attuali del diario non prevedono autore materiale distinto dall’account, ora del fatto, lingua dichiarata, le sezioni strutturate di §2, chiusura o firma. (`server/migrations/sqlite/001_init.sql:37–48`, `server/migrations/sqlite/045_diary_versions.sql:1–16`, `server/repository.mjs:546–555`, `server/repository.mjs:573–676`, `server/http.mjs:1030–1036`)

| Caso | Evidenze da poter ricostruire |
| --- | --- |
| Contestazione di un ordine di servizio | Testo ricevuto o riferimento alla revisione del documento, istruzione effettivamente comunicata, mittente, destinatari, orari dichiarati e riscontri distinti. |
| Sospensione per meteo | Fonte e ora delle osservazioni, zona e lavorazioni interessate, inizio e ripresa se noti, decisione e responsabile, foto originali e osservazioni di segno diverso. |
| Difesa da una richiesta di risarcimento | Cronologia di fatti, impedimenti, risorse presenti e comunicazioni, con fonti, versioni e lacune visibili. L’export conserva anche le rettifiche rilevanti. |
| Consegna con riserva | Perimetro, partecipanti, verbale e revisione, difetti o riserve puntuali e prove disponibili; collegamento al successivo scioglimento della riserva senza alterare il verbale originario. |

## 2. Modello della voce

Prima adozione proposta: mantenere la scheda per sito, giorno operativo e turno. Una scheda può descrivere più fatti, ciascuno con identificatore stabile, autore materiale, ruolo e ora propri quando differiscono. Ogni voce ha un UUID stabile, ogni revisione pubblicata ha un proprio UUID e numero progressivo. Ogni nuovo fatto, raggruppamento o collegamento conserva la provenienza.

| Dato | In bozza | Alla chiusura |
| --- | --- | --- |
| Perimetro e stato | Sito, giorno operativo, turno, fuso IANA e cutoff applicati, stato iniziale bozza. | Congelare i valori registrati, validare la coerenza tra ora del fatto, giorno operativo e turno. |
| Attribuzione | L’account autenticato che registra è automatico. Persona materiale e ruolo operativo possono essere provvisori. | Autore materiale della voce o fonte identificata, ruolo operativo al momento del fatto e relativa impresa se pertinente. Conservare UUID e snapshot delle etichette. Indicare chi ha osservato, chi ha riferito e chi ha trascritto quando distinti. |
| Tempi | Tenere l’ora dichiarata dal dispositivo, se locale, e assegnare l’ora di registrazione server al primo salvataggio riuscito. Ora del fatto facoltativa. | Per ogni fatto usare ora o intervallo con inizio incluso e fine esclusa, fonte, offset e precisione, oppure dichiarare l’ora ignota con motivazione e precisione disponibile. Conservare ricezione e registrazione server, distinte dall’ora del fatto e dall’ora locale. |
| Lingua e contenuto | Lingua dichiarata dall’autore, IT o EN, e almeno un contenuto o un’acquisizione fotografica. I testi possono essere incompleti. | Confermare lingua e sintesi di consuntivo. Piano, impedimenti e prossimo passo devono avere testo oppure un esito esplicito con motivazione quando il dato manca. Preservare la lingua originale di citazioni e allegati. |
| Meteo e risorse | Sezioni facoltative. | Compilare ogni sezione pertinente oppure indicare «nessuno», «non applicabile» o «non rilevato» secondo il caso. Meteo con fonte, ora, unità e impatto. Manodopera con squadra o impresa, quantità e periodo, senza dettaglio nominativo HR per impostazione predefinita. Mezzi con tipo o asset, quantità, utilizzo e periodo. |
| Consegne, visitatori, istruzioni | Righe facoltative e riferimenti provvisori. | Per le righe pertinenti indicare fatto, ora e fonte, impresa o persona secondo necessità, documento e revisione se disponibili. Per le istruzioni registrare mittente, destinatari e canale. Per le consegne registrare esito e riserve. Indicare esplicitamente assenza, inapplicabilità o dato non rilevato. |
| Luoghi, attività ed evidenze | Riferimenti risolvibili oppure da riconciliare, con foto locali in attesa chiaramente indicate. | Luogo pertinente o motivazione per voce generale di sito. Riferimenti operativi applicabili con stato risolto o lacuna dichiarata. Le foto seguono §4. |

Per intervalli che attraversano un turno, indicare nel testo il fatto continuativo e collegare le voci pertinenti senza duplicare le prove. Conservare testi storici, null, account, motivazioni, date e allegati delle voci pregresse come storico legacy. Mostrare i campi mancanti come non registrati. Una designazione retrospettiva richiede una fonte e un atto esplicito. Nessuna chiusura o firma attribuita automaticamente ai dati pregressi.

## 3. Ciclo di vita e rettifiche

- **Bozza.** L’editor abilitato al diario crea o modifica le bozze proprie o assegnate. L’owner può intervenire sulle bozze del sito. Ogni salvataggio aggiorna la revisione di concorrenza e traccia account e istante.
- **Chiuso.** L’owner o un editor con delega esplicita valida per il sito chiude online dopo i controlli di §2 e §4. In una sola operazione il server verifica permessi, revisione attesa e disponibilità dei file, registra chiusura e autore dell’atto, congela contenuto, riferimenti, metadati e indice dei file tramite digest di uno snapshot canonico. Da quel momento il contenuto della revisione è immutabile.
- **Firmato.** L’owner o il verifier espressamente designato, con accesso al diario e autorizzato per la voce, conferma online dopo nuova autenticazione. Nel profilo proposto il firmatario è distinto da chi ha chiuso. L’atto esplicito associa account, persona, ruolo, istante server, metodo di autenticazione e digest della revisione chiusa. Registrazione dell’atto e passaggio a firmato sono atomici. La firma iniziale è un’attestazione applicativa soggetta alla decisione di §10. Firma, chiusura e archiviazione producono eventi tracciabili.
- **Rettifica.** Un editor autorizzato o l’owner apre una nuova bozza a partire dalla revisione pubblicata, con motivo, riferimento all’originale e alla revisione precedente. La nuova versione segue lo stesso ciclo, con una propria firma. Fino alla firma della rettifica, l’ultima versione firmata conserva la sua evidenza e la rettifica è visibile come pendente. Se nessuna versione è firmata, distinguere l’ultima chiusa dalla bozza in corso. Bloccare aggiornamenti diretti ai contenuti congelati, anche a owner e tramite allegati. Conservare versioni, motivazioni e firme consultabili in ordine.
- **Concorrenza.** Chiusura, firma e pubblicazione di una rettifica controllano la revisione attesa e si serializzano per voce. Archiviazione logica motivata e accesso allo storico seguono i permessi del sito. La rimozione da una vista operativa non cambia snapshot, digest o firme.

## 4. Archivio visivo

Gli allegati attuali hanno un’entità proprietaria, metadati di upload e SHA-256. Il server verifica anche i byte riletti dallo storage e dispone di una via di eliminazione. Il contratto corrente per gli allegati del diario li associa alla voce, senza indice di evidenza per luogo, ora dello scatto e attività. (`server/repository.mjs:679–709`, `server/repository.mjs:750–804`, `server/repository.mjs:834–849`, `server/http.mjs:906–935`)

Ogni foto del nuovo archivio ha un UUID di evidenza, un originale privato con hash e dimensione, una revisione della voce e un luogo dello stesso sito. Collegare l’attività quando pertinente o dichiararne l’inapplicabilità con motivo. La ricerca autorizzata filtra per luogo e discendenti, data del fatto o dello scatto e attività, segnalando l’origine del filtro temporale. Mostrare il percorso storico alla data del fatto. Memorizzare didascalia, fonte e autore dello scatto se dichiarato, ora e offset dichiarati, dato EXIF se disponibile e pertinente, ora di ricezione, tipo convalidato e provenienza. Mostrare eventuali divergenze tra orari. Se lo scatto è di data ignota, registrare esplicitamente la lacuna e rendere la foto recuperabile tramite data della voce. La posizione GPS è facoltativa e soggetta alla politica approvata. Derivati e anteprime hanno un proprio ID e possono omettere metadati sensibili. L’originale conserva i byte acquisiti.

Un upload temporaneo privo di legame valido rimane in staging e fuori dall’archivio. Un file in attesa, illeggibile, mancante o con digest errato blocca la chiusura se dichiarato come evidenza disponibile. Prima della chiusura si può ritentare oppure trasformare il riferimento in una lacuna esplicita con motivo e approvazione del responsabile della chiusura. Un requisito contrattuale di evidenza obbligatoria, se configurato, continua a bloccare la chiusura. Una perdita successiva si segnala con evento di disponibilità, esito del recupero e stato incompleto nell’export. Digest e riferimento originari restano invariati. Un ripristino vale come originale soltanto se i byte corrispondono al digest.

Scadenza del download, archiviazione logica e termine di conservazione sono distinti. Scaduto un link autorizzato, l’originale segue la propria politica e rimane accessibile agli autorizzati. Una contestazione sospende lo smaltimento secondo §10. Le foto acquisite seguono la conservazione della voce e dei fascicoli che le referenziano, con eventuali vincoli più lunghi approvati. Nessuna eliminazione fisica ordinaria. La pulizia di upload temporanei non acquisiti, dopo la finestra di ripresa approvata, è separata dallo smaltimento delle evidenze.

## 5. Offline e riconciliazione

La coda attuale comprende creazione diario, creazione e transizioni attività e upload allegati, anche con risoluzione dell’ID locale dell’entità. Può accorpare creazioni diario locali ancora mai inviate. Al replay controlla la sessione, conserva il giorno e il turno di una scrittura differita e gestisce esiti incerti. Le rettifiche del diario e la creazione delle ispezioni chiamano direttamente l’API. (`app/offline.mjs:6–7`, `app/offline.mjs:82–88`, `app/offline.mjs:158–209`, `app/app.mjs:2867`, `app/app.mjs:4425–4449`)

Senza rete l’utente già autenticato, con cache e spazio disponibili, può creare e modificare una bozza locale e acquisire foto originali con metadati dichiarati, usando riferimenti già disponibili o contrassegnati per riconciliazione. L’interfaccia indica salvataggio locale, attesa, conflitto ed esito confermato. Segnala quota esaurita e perdita di persistenza senza mostrare una conferma di salvataggio. Chiusura, firma, export, acquisizione di autorizzazioni e scritture delle ispezioni richiedono rete. L’accesso esterno leggero resta online.

Al ritorno della rete:

1. Verificare account, sito e permessi correnti. Isolare bozze e blob per account e sito, anche su dispositivi condivisi. Sospendere il replay se la sessione cambia o l’accesso è revocato.
2. Inviare prima voce e riferimenti, poi le foto e i relativi legami. Usare UUID stabili del client e chiavi di idempotenza persistenti lato server per operazione, sito e account. Stessa chiave e stesso contenuto restituiscono lo stesso esito, anche dopo timeout. Stessa chiave con contenuto diverso produce conflitto. L’hash del file aiuta la diagnosi, con acquisizioni identiche ammesse in contesti distinti.
3. In caso di slot occupato da un altro UUID, revisione superata o voce già chiusa, preservare la copia locale e l’indice delle foto. Mostrare le differenze e far confluire i contributi in una bozza compatibile o in una rettifica esplicita previa scelta dell’utente autorizzato. L’operazione risolta ha una nuova chiave e usa la revisione aggiornata. Un esito incerto si riconcilia tramite la chiave originale.
4. Salvare valore grezzo, offset, fuso dichiarato, precisione, provenienza e ora server di ricezione. Usare fuso e cutoff del sito per il giorno operativo, richiedendo offset esplicito per orari locali ambigui. Confrontare l’ora dichiarata del fatto con l’ora server e una tolleranza configurabile approvata. Oltre tale soglia respingere la mutazione ufficiale e preservare la copia locale per rettifica motivata. Conservare dichiarazione originaria e motivazione. Segnalare anche registrazioni tardive secondo la politica del sito.

Offline l’ora del dispositivo o dell’EXIF è una dichiarazione. Il primo riscontro server attesta quando ha ricevuto il contenuto associato al digest, entro l’affidabilità dell’orologio server. Una prova temporale indipendente richiede una fonte o un servizio approvato, con riferimento conservato nel fascicolo.

## 6. Pacchetto evidenze esportabile

L’export esistente produce un CSV con attività, deviazioni e metadati degli allegati, con checksum accoppiato. Il fascicolo qui proposto aggiunge voci, versioni, originali ed eventi di attestazione. (`server/evidence-export.mjs:24–62`, `server/http.mjs:943–963`)

- **Perimetro.** Generare uno ZIP a partire da sito, periodo con fine esclusa e selezione esplicita di voci. Congelare ID del fascicolo, istante server di generazione, perimetro, filtri, versioni incluse e copertura. Il fascicolo ufficiale contiene revisioni chiuse e firmate, catena delle rettifiche, ruoli, attribuzioni, motivazioni, tempi con fonti, riferimenti e originali autorizzati. Dichiarare stato, lacune e limitazioni della selezione senza rivelare record riservati. Se manca una dipendenza obbligatoria per il fascicolo richiesto, bloccare l’emissione completa e consentire solo un risultato dichiarato incompleto nei limiti autorizzati.
- **Formati.** Includere un indice JSON UTF-8 con versione del formato e regole pubblicate di serializzazione canonica, un rendiconto PDF leggibile, i file originali nei formati acquisiti e un checksum separato dell’indice. L’export indica i riferimenti ai documenti e le revisioni e include le copie autorizzate quando previste dal perimetro. Le due presentazioni sono italiano `it-IT` e inglese britannico `en-GB` (UK). Identificatori, valori macchina, orari con offset e testi originali restano identici. Eventuali traduzioni sono etichettate e associate al testo originale.
- **Integrità.** L’indice elenca percorsi univoci, tipo, dimensione, SHA-256 dei byte di ciascun file, digest degli snapshot e stato delle evidenze mancanti. Indica gli eventi di chiusura e firma e il digest della revisione a cui ogni firma si riferisce. Ricalcolare i digest degli originali in esportazione. Mettere a disposizione del destinatario il digest dell’indice tramite un canale fidato distinto dal file consegnato, oppure una firma verificabile dell’indice se approvata. Conservare nell’audit ID, digest, autore, istante e perimetro dell’emissione.
- **Verifica indipendente.** Fornire istruzioni per verificare il checksum dell’indice, ricalcolare i digest dei file, rilevare elementi mancanti, aggiunti o alterati, seguire la catena di versioni e confrontare il digest attestato con lo snapshot. Indicare quali orari e identità sono dichiarati, attestati dall’app o sostenuti da una prova esterna. Un digest fidato permette di verificare l’integrità del pacchetto corrispondente. L’autenticità di eventuali firme crittografiche richiede materiale e regole di verifica approvati. Il contenuto resta una registrazione con fonti ed eventuali lacune.

## 7. Collegamenti con gli altri registri

Applicare la [specifica di luoghi e asset](places-and-assets.md) e la proposta di persone e imprese, `docs/people-and-companies.md` alla revisione `7a9b038`, come dipendenze di progetto. Usare UUID stabili, perimetro per sito, archiviazione logica, validità con inizio incluso e fine esclusa e nessuna eliminazione fisica ordinaria. Uno snapshot di revisione conserva ID, etichetta, percorso, ruolo e fonte pertinenti alla data del fatto. Rinomine, spostamenti, cambi di affiliazione e archiviazioni lasciano leggibili i collegamenti storici. I legami privi di ID stabile richiedono riconciliazione esplicita conservando il valore originale.

| Registro | Relazione proposta |
| --- | --- |
| Luoghi, asset e attività | Collegare il luogo preciso del fatto o dello scatto, l’eventuale asset nella posizione valida a quell’ora e le attività interessate. Un luogo generale richiede una motivazione di perimetro. |
| Persone e imprese | Collegare l’autore materiale, i soggetti coinvolti e le affiliazioni pertinenti. L’account registra l’azione applicativa. Evitare deduzioni di identità da omonimie, contatti o dati HR. |
| Ispezioni | Referenziare il record HSE e la sua revisione, se disponibile. Il diario può attestare che l’ispezione è avvenuta. Esito e allegati HSE seguono i permessi e il flusso del modulo sorgente. |
| Difetti e documenti | Quando i registri lo consentono, collegare difetto, riserva e documento tramite ID e revisione storica. Per un documento acquisito come evidenza conservare il digest. Per un registro futuro o un riferimento irrisolto mantenere la fonte dichiarata. Una deviazione già esistente resta un collegamento tipizzato distinto. |

## 8. Permessi e ambiente demo

Il diario esistente applica membership, ruolo e accesso al modulo nelle operazioni di scrittura e lettura dello storico. Il ruolo `demo_user` è già previsto e l’assegnazione è vincolata al sandbox. (`server/repository.mjs:90–102`, `server/repository.mjs:129–135`, `server/repository.mjs:573–593`, `server/repository.mjs:622–675`, `server/admin.mjs:56–65`)

| Attore | Perimetro proposto |
| --- | --- |
| Owner | Consulta lo storico del sito, amministra deleghe e archiviazione, chiude e firma alle condizioni di §3, genera fascicoli nei limiti dei permessi sui dati inclusi. |
| Editor | Consulta le voci consentite, redige, allega e propone rettifiche entro l’assegnazione. Chiude con delega esplicita. |
| Verifier | Consulta le revisioni consentite, firma quella chiusa se designato. |
| Viewer | Consulta revisioni chiuse o firmate consentite. Download e export richiedono le rispettive autorizzazioni. |
| Demo user | Nel solo sandbox autorizzato consulta dati sintetici e simula bozze, foto, chiusura, firma e export nei casi predisposti. Attestazioni, PDF e indice riportano il carattere simulato. Nessun accesso a siti ordinari o emissione di link esterni. |
| Accesso esterno leggero | Vede la sola richiesta di foto o l’oggetto già condiviso secondo la specifica persone e imprese. Può inviare contributi se autorizzato. Il contributo viene approvato internamente con provenienza esplicita. Nessuna consultazione del diario, degli originali preesistenti o del fascicolo, né chiusura o firma. |

Applicare i controlli lato server a ogni richiesta, inclusi storico, anteprime, ricerca per luogo, conteggi, PDF e download. Verificare i permessi del modulo sorgente anche nelle viste trasversali e omettere identificatori e attributi riservati. Una consegna a terzi è un’emissione esplicita del fascicolo autorizzato con audit del destinatario e del perimetro. Accessi nominativi HR e dati di contatto richiedono i relativi permessi.

## 9. Criteri di accettazione e test negativi

| Prova | Esito verificabile |
| --- | --- |
| Firma dopo chiusura | La firma su bozza fallisce. Dopo chiusura il firmatario autorizzato e distinto da chi ha chiuso può firmare soltanto il digest atteso. Firma con revisione superata o permessi revocati fallisce senza evento parziale. |
| Correzione della versione firmata | Un aggiornamento diretto, anche di metadati o allegati, viene respinto. Una rettifica motivata crea un altro UUID di revisione, percorre chiusura e firma e lascia verificabili digest, firma e file della precedente. |
| Foto orfana | Foto con voce assente o di altro sito resta fuori dall’archivio, dalle ricerche e dall’export. Una foto attesa ma assente blocca la chiusura salvo lacuna approvata ove ammesso. Perdita dopo la firma produce fascicolo incompleto con digest originale conservato. |
| Voce con ora futura | Con orologio server controllato, un fatto oltre la tolleranza viene respinto e resta modificabile nella copia locale. Un’ora ambigua senza offset richiede esplicitazione. Una registrazione differita conserva i tempi distinti. |
| Conflitto offline | Due client partono dalla stessa revisione e uno chiude prima del replay dell’altro. Il secondo riceve conflitto, mantiene testo e foto, e può proporre una rettifica. Un replay con stessa chiave dopo perdita della risposta produce un solo record e un solo legame per operazione. |
| Integrità del fascicolo | Il destinatario rileva un byte modificato, un file rimosso o aggiunto e una versione disallineata. Il cambio IT/UK preserva testi originali, riferimenti e digest degli snapshot. Una rinomina successiva di luogo o impresa lascia invariato il fascicolo già emesso. |
| Permessi e dati pregressi | Un viewer non scrive. Un utente privo di permesso HSE non ricava informazioni da link, ricerca o export. Un demo user e un link esterno non escono dal rispettivo perimetro. Un record legacy conserva campi e storico senza identità o firme aggiunte d’ufficio. |

Verificare concorrenza e invarianti sui due database supportati. Provare il percorso mobile con disconnessione, ricaricamento, timeout al replay ed esaurimento dello spazio, controllando i messaggi e la visibilità degli originali.

## 10. Rischi, fuori scope e decisioni dell’owner

| Rischio | Controllo o decisione |
| --- | --- |
| Firma applicativa interpretata come firma digitale legalmente valida | L’owner definisce con il referente legale giurisdizioni, valore richiesto, categorie di documenti, metodo, eventuale prestatore e requisiti di verifica a lungo termine. L’eventuale uso di certificati, marca temporale, dati di revoca e rinnovo delle prove richiede una decisione prima dell’uso formale previsto. |
| Perdita di evidenze o conservazione eccessiva | Approvare durata e decorrenza per dati, originali, fascicoli, audit e backup, responsabilità e procedura per recupero, blocco per contenzioso, eccezioni obbligatorie ed eventuale smaltimento autorizzato. Provare ripristino e controllo dei digest. Nessuna durata è deducibile dal codice. |
| Attribuzione debole e tempo contestato | Approvare fonti ammissibili, limite di tolleranza oraria, regole per registrazioni tardive e fuso applicabile. Stabilire quando richiedere riscontro esterno o marca temporale. |
| Risorse e informazioni personali esposte | Approvare campi nominativi, GPS, visualizzazione, deleghe, emissioni a terzi e minimizzazione del fascicolo. Concordare accesso al sandbox e durata dei dati locali su dispositivi condivisi. |
| Vincoli operativi troppo rigidi | Confermare granularità per turno, separazione tra chiusura e firma, gestione delle sostituzioni, sezioni obbligatorie per tipo di evento e deroghe per prove mancanti. Stabilire ordine di rilascio delle dipendenze e adozione dei record precedenti. |

Granularità per turno, firma online con due attori distinti, presentazione `en-GB` e possibilità di dichiarare lacune sono ipotesi progettuali. La disponibilità dei registri referenziati dipende dal rilascio delle specifiche collegate.

Fuori scope iniziale: firma digitale con certificati o servizi fiduciari, firma offline, modifiche offline alle ispezioni, acquisizione automatica da sensori o servizi meteo, classificazione automatica delle foto, riconoscimento delle persone, rilascio del modulo difetti e sincronizzazione in scrittura con i sistemi sorgente.
