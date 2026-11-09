---
title: API REST
description: Endpoint, autenticazione, errori e idempotenza dell'API di SiteAssistant.
---

L'API è un servizio HTTP in Node.js senza framework. Il frontend statico la chiama direttamente.

## Base URL e CORS

- Base predefinita del client: `https://api.siteassistant.asassi.cloud`.
- Con `<meta name="siteassistant-api-base" content="/">` il client usa la stessa origine che serve i file statici.
- Il server autorizza con CORS solo l'origine `https://siteassistant.asassi.cloud`, con credenziali.
- Le risposte sono sempre `Cache-Control: no-store`.

## Autenticazione

Non esistono token API. L'autenticazione avviene con il cookie di sessione `sa_session`, ottenuto da `POST /api/auth/login` e inviato automaticamente dal browser con `credentials: 'include'`.

## Endpoint

| Metodo | Percorso | Ruolo richiesto | Note |
| :-- | :-- | :-- | :-- |
| GET | `/api/health` | nessuno | `{ "status": "ok" }` |
| POST | `/api/auth/login` | nessuno | `{ email, password }`; imposta il cookie |
| GET | `/api/auth/me` | autenticato | Utente e ruoli per cantiere |
| POST | `/api/auth/logout` | autenticato | Revoca la sessione |
| GET | `/api/sites` | autenticato | Solo i cantieri in cui sei membro |
| POST | `/api/sites` | owner | `code`, `name`, `location`, `start_date`, `end_date` |
| GET | `/api/sites/{id}` | membro | Dettaglio cantiere |
| GET | `/api/sites/{id}/members` | owner | Elenco membri e ruoli |
| POST | `/api/sites/{id}/members` | owner | `{ user_id, role }`; `role: null` rimuove |
| GET | `/api/tasks?siteId=&status=` | membro | Filtri opzionali |
| POST | `/api/tasks` | owner/editor/verifier | Supporta `Idempotency-Key` |
| GET | `/api/tasks/{id}` | membro | Include la cronologia eventi |
| POST | `/api/tasks/{id}/transition` | owner/editor/verifier | `{ to, note?, reason? }` |
| GET | `/api/diary?siteId=` | membro | Voci del cantiere |
| POST | `/api/diary` | owner/editor/verifier | Una voce per cantiere/data/turno |

## Corpo delle richieste

`Content-Type: application/json` è obbligatorio. Il corpo massimo è **65.536 caratteri**; oltre, la richiesta è rifiutata con `400 INVALID_JSON`.

Campi data in formato `YYYY-MM-DD`. Le date di diario sono calcolate sul giorno operativo, non sulla mezzanotte.

## Idempotenza

`POST /api/tasks` accetta l'header `Idempotency-Key`. Due richieste con la stessa chiave e lo stesso corpo restituiscono la stessa risposta senza creare due attività; con la stessa chiave e corpo diverso la richiesta viene rifiutata. La chiave è legata all'utente che l'ha inviata.

## Errori

Formato:

```json
{ "error": "Human readable message.", "code": "ERROR_CODE" }
```

| Codice | HTTP | Significato |
| :-- | :-- | :-- |
| `VALIDATION_ERROR` | 400 | Campo mancante o non valido |
| `INVALID_JSON` | 400 | Content-Type o corpo non validi |
| `INVALID_CREDENTIALS` | 401 | Login fallito |
| `FORBIDDEN` | 403 | Ruolo insufficiente sul cantiere, o transizione riservata al verificatore designato o a un owner |
| `NOT_FOUND` | 404 | Risorsa o rotta inesistente |
| `DUPLICATE_SITE_CODE` | 409 | Codice cantiere già usato |
| `DUPLICATE_DIARY` | 409 | Voce già presente per cantiere/data/turno |
| `INVALID_TRANSITION` | 409 | Transizione non ammessa |
| `SEPARATE_PEOPLE_REQUIRED` | 400 | Esecutore e verificatore coincidono |
| `NOTE_REQUIRED` / `REASON_REQUIRED` | 400 | Nota o motivazione obbligatoria |
| `RATE_LIMITED` | 429 | Troppi tentativi di login |
| `INTERNAL_ERROR` | 500 | Errore non gestito |

## Esempio

```sh
curl -s -X POST https://api.siteassistant.asassi.cloud/api/auth/login \
  -H 'Content-Type: application/json' \
  -c cookies.txt \
  -d '{"email":"mario.rossi@example.com","password":"..."}'

curl -s https://api.siteassistant.asassi.cloud/api/tasks?siteId=UUID \
  -b cookies.txt
```

L'API non espone OpenAPI: questa tabella è il contratto corrente. Per lo schema dati completo vedi `database/README.md` nel repository.
