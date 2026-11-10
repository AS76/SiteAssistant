# Import e archivio documenti — modalità complementare

Stato: **aggiornato (2026-11-10).** Storage S3 iDrive e2 attivo (bucket `siteassistant`); l'import reale (profili di mapping) non è ancora attivato in produzione.

## Perimetro

Il prodotto è uno strumento interno che affianca un sistema sorgente. Importa export, collega documenti, prepara viste e annotazioni e registra lavoro interno. Il sistema sorgente mantiene i propri dati e flussi ufficiali. Non è previsto aggiornamento automatico del sistema esterno, invio di messaggi o chiusura di item in quel sistema.

L'interfaccia mostra separatamente **stato importato**, **dato interno** e **data dell'ultimo export**. La chiusura o verifica interna non implica che il record sia stato chiuso o accettato nel sistema sorgente.

## Ripartizione delle responsabilità

| Componente | Dati e responsabilità |
| --- | --- |
| Sistema sorgente | Identificativi, campi e stati ufficiali inclusi negli export |
| Archivio S3 compatibile | Originali e versioni dei file, allegati e derivati autorizzati |
| PostgreSQL | Record normalizzati, provenienza, indici dei documenti, snapshot, relazioni, note e storico interno |
| Applicazione (VPS + Neon) | Import guidato, controlli, Gantt e mappe, viste incrociate, accessi e operazioni interne |
| Connettori di acquisizione | Lettura di file selezionati da sorgenti autorizzate; disponibilità e permessi da verificare per ogni canale |

## Accesso ai file: API e MCP

### API S3 nel backend

Canale primario proposto per il funzionamento della web app: SDK S3 compatibile sul server. Endpoint, regione, bucket, prefissi ammessi e credenziali sono configurazione privata del deployment, non valori inclusi nel codice o nella documentazione pubblica.

- Consentire soltanto i bucket/prefissi assegnati all'applicazione e verificare l'autorizzazione per cantiere prima di elencare, leggere o consegnare un file.
- Iniziare con lettura di oggetti selezionati; niente scansione indiscriminata dell'account, cancellazioni, cambi ACL o sovrascritture degli originali.
- Conservare il riferimento all'oggetto e, se disponibile, il suo identificativo di versione. Calcolare un checksum di contenuto quando necessario: l'ETag non è sempre un hash del contenuto.
- Gli URL firmati sono temporanei e non si salvano come indirizzi permanenti. Download tramite backend o link a breve scadenza dopo controllo accessi; cache del viewer compatibile con la scadenza.
- Configurare CORS solo se serve realmente l'accesso diretto del browser. Le credenziali S3 non arrivano al frontend.
- Eventuali scritture per upload, anteprime o report richiedono un'area di output separata e permessi espliciti. Nessun trasferimento di file tra ambienti avviene automaticamente.
- Verificare sul servizio effettivo firma delle richieste, letture parziali per PDF, URL firmati, limiti e comportamento delle versioni. La compatibilità generica S3 non conferma tutte le capacità del provider.

### MCP come canale aggiuntivo

MCP può consentire operazioni assistite sui file se è disponibile un server con strumenti e permessi adeguati. Non è un requisito del browser e non sostituisce il modello documentale o la persistenza dell'applicazione.

Un eventuale adattatore MCP traduce solo strumenti realmente disponibili in operazioni applicative autorizzate. Mantiene provenienza, identificativo del file e risultato dell'operazione. I contenuti dei file e gli output del connettore sono dati, non istruzioni da eseguire. Disponibilità, autenticazione e capacità di download vanno provate prima di dichiarare operativa un'integrazione.

## Import degli export

Il sistema prevede adattatori distinti per famiglie di export; la presenza e la struttura delle famiglie vanno confermate sui campioni. Possibili ambiti da verificare: pianificazione, avanzamento, attività/deviazioni e registri documentali.

1. **Selezione:** scegliere un file autorizzato, da caricamento, riferimento S3 o connettore disponibile.
2. **Acquisizione:** leggere versione e metadati, calcolare checksum e registrare data di riferimento dell'export separatamente dalla data di acquisizione.
3. **Riconoscimento:** proporre famiglia e versione del profilo; chiedere conferma per file non riconosciuti. Nessuna deduzione silenziosa dal solo nome.
4. **Anteprima:** fogli e intestazioni, mapping, conteggi, formati, fusi e righe respinte con ragione.
5. **Staging:** caricare i record in un lotto isolato; validare ID, gerarchie, riferimenti e mapping degli stati prima di renderli visibili nei report correnti.
6. **Confronto:** mostrare aggiunte, modifiche e assenze rispetto allo snapshot precedente dello stesso ambito e popolazione. Una riga assente non equivale a un item cancellato o chiuso.
7. **Conferma:** rendere disponibile uno snapshot immutabile e aggiornare le viste del dato importato tramite una transazione applicativa controllata.
8. **Arricchimento interno:** collegare note, pianificazione di lavoro, consuntivi, verifiche interne e documenti senza modificare lo snapshot o scrivere nel sistema sorgente.

### Identità, duplicati e stati

- Chiave del record esterno: sorgente + cantiere/ambito + famiglia + ID esterno stabile. Non usare titolo o numero di riga come identità.
- Identità del lotto: checksum, sorgente, ambito e versione del profilo. Ritentare un'acquisizione non duplica dati o progressi. Riprocessare lo stesso file con un nuovo mapping è un'operazione esplicita con lineage.
- Conservare stato/codice originale, stato normalizzato e versione della regola di mapping. Valori sconosciuti rimangono segnalati, non vengono trasformati automaticamente in “chiuso”.
- Distinguere autore del record, assegnatario e impresa quando presenti. Il significato concreto delle colonne deve essere validato sul campione.
- Il timestamp dell'export non basta a ricostruire tutti gli eventi precedenti. I trend usano snapshot confrontabili o eventi realmente disponibili; non inventano passaggi di stato.
- Gli aggiornamenti interni sono associati al record stabile e possono risultare in conflitto con il nuovo export. Mostrare il conflitto e permettere riconciliazione esplicita; nessun sovrascrivere o propagare automaticamente.

## Campi autorevoli e aggiornamenti interni

| Famiglia di dati | Regola proposta |
| --- | --- |
| Stato, date e assegnazioni ufficiali del record esterno | Conservati nello snapshot con data, fonte e versione |
| Baseline importata | Revisione immutabile; scelta della baseline esplicita |
| Piano corrente interno e progressi dichiarati/verificati | Dati applicativi separati, etichettati come interni; nessuna modifica del sistema esterno |
| Note, collegamenti e annotazioni su mappe | Informazioni interne collegate al record e alla revisione del documento |
| Report ed export prodotti dall'app | Artefatti derivati con data del dato e origine; eventuale invio esterno è un'azione distinta |

## Modello dati aggiuntivo

| Entità proposta | Scopo |
| --- | --- |
| source_connections | Metadati della sorgente e riferimento alla configurazione privata; nessuna chiave segreta in tabella |
| import_profiles e import_profile_versions | Schemi attesi, mapping, campi e normalizzazione degli stati versionati |
| import_batches e import_files | File, checksum, versione, popolazione, data del dato, data importazione, esito e contatori |
| external_records | Identità stabile del record nel suo ambito |
| external_record_snapshots | Valori originali e normalizzati per lotto; immutabilità e lineage |
| internal_record_links | Foreign key tipizzate verso attività, deviazioni o voci di piano/avanzamento interne |
| reconciliation_items | Differenze e conflitti da rivedere, esito e autore della decisione |
| storage_objects e document_versions | Locator privato, versione, checksum, dimensione, formato e associazione al documento |

Il database conserva riferimenti ai segreti gestiti dal runtime, non i segreti stessi. Per record e collegamenti valgono isolamento per organizzazione/cantiere e autorizzazioni server.

## Esempi reali e materiale pubblico

I campioni privati vengono analizzati fuori dal checkout pubblico, limitando la lettura ai file selezionati. Nel repository possono entrare adattatori generici, mapping senza identificativi riservati e fixture sintetiche. Non entrano file reali, nomi di progetti o persone, indirizzi, ID di cartelle/bucket, endpoint di account, schermate reali, token o URL firmati.

Analisi, file e mapping specifici sono materiali privati, separati da questo repository. La loro disponibilità sul sistema di sviluppo deve essere verificata prima di usare un adattatore reale. Un tag a un'app non dimostra che i suoi strumenti siano disponibili alla sessione. Occorrono strumenti callable o file selezionati forniti tramite un canale accessibile; non vengono cercate credenziali nei documenti.

## Primo incremento e verifiche

Il primo import concreto viene scelto dopo aver esaminato un export autorizzato. Preparare un profilo, una fixture sintetica equivalente, anteprima e mapping, caricamento idempotente e confronto di due snapshot. Poi collegare file S3 selezionati in sola lettura.

È disponibile uno [schema SQL generico con test sintetici](../database/README.md). Non contiene intestazioni o dati riservati e non costituisce un importatore operativo. I mapping privati devono essere revisionati rispetto ai nomi canonici e mantenuti fuori dal checkout.

Verifiche: retry senza duplicati, mapping sconosciuto segnalato, nessuna perdita di note al reimport, data export distinta da data importazione, record assente non marcato chiuso, stato esterno separato da verifica interna, file non autorizzato inaccessibile, link scaduto gestito senza esporre segreti, nessuna scrittura sui sistemi sorgenti.
