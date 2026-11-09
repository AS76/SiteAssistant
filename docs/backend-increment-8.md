# Incremento 8 — Allegati

Implementati nel backend: allegati a `task`, `diary` e `site`, autorizzazione tramite sessione e membership, client S3 SigV4 senza dipendenze aggiuntive, readback SHA-256 e download in streaming attraverso l'API. L'interfaccia grafica per gli allegati non fa parte di questo incremento.

La migrazione `007_attachments.sql` è disponibile per PostgreSQL e SQLite e viene scoperta dal runner esistente. Non è stata applicata a un database operativo. Nessun servizio, bucket, credenziale o deploy è stato configurato da questo incremento.

## Configurazione runtime

Fornire nell'ambiente server `S3_ENDPOINT` (HTTPS), `S3_BUCKET`, `S3_ACCESS_KEY` e `S3_SECRET_KEY`. Nessun valore reale va salvato nel repository. Il client usa richieste path-style; la regione di firma predefinita è `us-east-1`, con override opzionale `S3_REGION` quando richiesto dall'endpoint. Senza configurazione, le operazioni sui file rispondono `503 STORAGE_NOT_CONFIGURED`; il resto dell'API continua a funzionare.

Il bucket deve essere privato e avere SSE abilitata. Il client eredita la cifratura configurata sul bucket, senza cifratura client-side né modifiche alle policy. La configurazione SSE e il funzionamento sul provider reale richiedono verifica nell'ambiente operativo: i test non accedono a S3.

## API

| Metodo e percorso | Accesso | Risultato |
| --- | --- | --- |
| `POST /api/attachments` | Owner/editor dell'entità | `201`, metadati del nuovo allegato |
| `GET /api/attachments?site_id=…&entity_type=…&entity_id=…` | Membro del cantiere | `200`, array di metadati |
| `GET /api/attachments/:id` | Membro del cantiere | `200`, byte in streaming |
| `DELETE /api/attachments/:id` | Owner/editor | `204` |

POST accetta un oggetto JSON con `entity_type`, `entity_id`, `filename`, `content_type` e `data_base64`. Esempio interamente sintetico (sostituire l'UUID con un'entità di test esistente):

```json
{
  "entity_type": "diary",
  "entity_id": "00000000-0000-4000-8000-000000000001",
  "filename": "synthetic.pdf",
  "content_type": "application/pdf",
  "data_base64": "JVBERiBzeW50aGV0aWM="
}
```

Il cantiere è ricavato dall'entità; un eventuale `site_id` esplicito deve corrispondere. Entità mancanti/ID malformati producono `400`; collegamenti tra cantieri o ruoli insufficienti producono `403`. In lista `site_id` è obbligatorio, `entity_type` è facoltativo; per filtrare `entity_id` occorre anche `entity_type`. I metadati restituiti comprendono dimensione, SHA-256 esadecimale, autore, timestamp e `manifest_version: "v1"`, senza locator di storage, endpoint o URL di accesso.

Il massimo decodificato è 15 MiB (15 × 1024 × 1024 byte), con base64 canonico e non vuoto. Il limite JSON specifico consente l'espansione base64 più 64 KiB di overhead; le altre route conservano il limite di 64 KiB. Dimensione eccessiva: `413`; MIME diverso da `image/*` o `application/pdf`: `415`. Il controllo MIME riguarda il tipo dichiarato, non è un antivirus né un parser del formato. Il nome deve essere valido, entro 255 byte UTF-8 e senza percorsi o caratteri di controllo.

I download sono forzati come allegato con nome UTF-8, `nosniff`, CSP sandbox e `Cache-Control: no-store`. Non vengono generati URL pubblici o firmati. La lettura è autenticata prima di contattare lo storage; un errore durante lo stream interrompe la risposta senza aggiungere JSON ai byte del file.

## Integrità e gestione degli errori

Ogni upload crea una chiave casuale distinta, con `If-None-Match: *`; non esiste una route per sovrascrivere file. La versione del manifest è `v1`, indipendente dal versioning nativo del bucket.

Sequenza: SHA-256 locale → PUT con checksum nei metadati → HEAD con confronto di checksum e dimensione → GET con ricalcolo SHA-256 sui byte → ricontrollo di entità/permessi e INSERT transazionale. Il GET aggiuntivo impedisce di considerare una semplice eco dei metadati come prova dell'integrità; ETag non viene interpretato come SHA-256. Un mismatch produce `502 ATTACHMENT_CHECKSUM_MISMATCH` senza inserire una riga.

Dopo un PUT confermato, errori di readback o INSERT causano un tentativo di DELETE compensativo. Se fallisce anche la pulizia, viene restituito `503 ATTACHMENT_CLEANUP_FAILED`. Per la cancellazione, un errore storage annulla la transazione SQL, mantenendo i metadati per riprovare; DELETE sullo storage è idempotente.

SQL e S3 non condividono una transazione distribuita. Un crash, un PUT con esito di rete incerto o un errore di commit dopo DELETE possono richiedere riconciliazione operativa tra chiavi e righe. La pulizia automatica degli orfani non è implementata; non eseguire reset del seed con allegati presenti. I test coprono gli errori compensabili, senza simulare una garanzia di atomicità tra i due servizi.

## Verifiche

`npm test` include le suite `attachments`, `attachments-schema` e `s3` tramite `tests/index.js`. Lo storage in-memory implementa `put/get/head/delete`; il client reale è verificato con trasporto iniettato e vettori SigV4 sintetici calcolati indipendentemente. Nessuna nuova suite usa rete o credenziali reali. SQLite e PostgreSQL in memoria verificano upgrade dalla `006`, tipi fisici, vincoli, indice, replay e operazioni repository.

Riferimenti del protocollo: [firma SigV4 AWS](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html) e [API S3 compatibili del provider](https://www.idrive.com/s3-storage-e2/s3-compatible-api).
