---
title: API REST
description: Riferimento degli endpoint per chi integra o amministra SiteAssistant.
---

:::tip[Questa pagina è per chi integra]
Se usi soltanto la webapp, non ti serve: questa è la documentazione tecnica dell'interfaccia HTTP che l'applicazione usa "dietro le quinte", utile per chi integra SiteAssistant o per chi lo amministra dal server.
:::

L'API è un servizio HTTP che il frontend chiama direttamente. Non esistono token API: l'autenticazione usa il cookie di sessione `sa_session`, ottenuto dal login e inviato automaticamente dal browser.

## Autenticazione e account

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/health` | nessuno | Stato del servizio |
| POST | `/api/auth/login` | nessuno | `{ email, password }`; imposta il cookie |
| GET | `/api/auth/me` | autenticato | Utente e ruoli per cantiere |
| POST | `/api/auth/logout` | autenticato | Revoca la sessione |
| POST | `/api/auth/request` | nessuno | Richiesta di accesso `{ email }` |
| GET/POST | `/api/auth/request/decide` | owner (via link email) | Approva o rifiuta una richiesta |
| POST | `/api/auth/password` | autenticato | Cambio password |
| POST | `/api/auth/forgot` | nessuno | Reset password `{ email }` |

## Cantieri

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/sites` | autenticato | Solo i cantieri di cui sei membro |
| POST | `/api/sites` | owner | `code`, `name`, `location`, `start_date`, `end_date` |
| GET | `/api/sites/{id}` | membro | Dettaglio cantiere |
| GET | `/api/sites/{id}/members` | owner | Elenco membri e ruoli |
| POST | `/api/sites/{id}/members` | owner | `{ user_id, role }`; `role: null` rimuove |

## Attività

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/tasks?siteId=&status=` | membro | Filtri opzionali |
| POST | `/api/tasks` | owner/editor/verifier | Supporta `Idempotency-Key` |
| GET | `/api/tasks/{id}` | membro | Include la cronologia eventi |
| POST | `/api/tasks/{id}/transition` | owner/editor/verifier | `{ to, note?, reason? }` |

## Diario

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/diary?siteId=` | membro | Voci del cantiere |
| POST | `/api/diary` | owner/editor/verifier | Una voce per cantiere/data/turno |

## Struttura progetto (WBS) e presenze (HR)

Queste aree sono esposte in **sola lettura**; l'import degli snapshot è riservato agli owner e avviene solo via API.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/wbs?site_id=` | membro | Albero della struttura |
| GET | `/api/wbs?site_id=&flat=1` | membro | Tabella piatta |
| GET | `/api/wbs/{id}` | membro | Nodo con figli immediati |
| POST | `/api/wbs/import` | owner | Promuove uno snapshot Time Schedule |
| GET | `/api/employees?site_id=` | membro | Dipendenti del cantiere |
| GET | `/api/employees/{id}` | membro | Dipendente con i suoi work days |
| GET | `/api/work-days?site_id=&employee_id=&from=&to=` | membro | Presenze filtrate per intervallo |
| POST | `/api/employees/import` | owner | Promuove uno snapshot presenze |

## Allegati

Gli allegati a attività, diario e cantiere sono disponibili **solo via API**; l'interfaccia non li espone ancora.

| Metodo | Percorso | Accesso | Note |
| :-- | :-- | :-- | :-- |
| POST | `/api/attachments` | owner/editor | Carica un file (base64) |
| GET | `/api/attachments?site_id=&entity_type=&entity_id=` | membro | Metadati degli allegati |
| GET | `/api/attachments/{id}` | membro | Scarica i byte |
| DELETE | `/api/attachments/{id}` | owner/editor | Elimina |

## Errori

Le risposte d'errore hanno la forma `{ "error": "messaggio", "code": "CODICE" }`. I codici più comuni: `VALIDATION_ERROR` (400), `INVALID_CREDENTIALS` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `DUPLICATE_SITE_CODE` e `DUPLICATE_DIARY` (409), `INVALID_TRANSITION` (409), `SEPARATE_PEOPLE_REQUIRED` (400), `NOTE_REQUIRED`/`REASON_REQUIRED` (400), `RATE_LIMITED` (429).

:::note
L'API non espone uno schema OpenAPI: le tabelle qui sopra sono il contratto corrente. Per lo schema dati completo vedi `database/README.md` nel repository.
:::
