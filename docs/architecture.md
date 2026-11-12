# Architettura — SiteAssistant (stato attuale)

Stato: **nucleo site-manager implementato e in produzione** (migrazioni 001–013). Stack reale verificato; nessun framework, nessun ORM. Documento allineato al codice il 2026-11-10.

## Cos'è

Webapp per il site manager: collega pianificazione, lavoro eseguito, verifica e diario di cantiere, usabile dal telefono in campo. Non un ERP: il livello tra il piano (SAP/P6/Excel) e la realtà quotidiana del cantiere.

**Perimetro attuale (nucleo site-manager):** WBS, presenze, avanzamento, deviazioni, prenotazioni ore, impatti economici. **Logistica materiali e procurement = milestone successiva.**

## Stack reale

| Livello | Tecnologia effettiva | Note |
| --- | --- | --- |
| Frontend | SPA statica in `app/` (HTML/CSS/JS nativo, no framework) | viste: Panoramica, Cantieri, Attività (board/elenco), Struttura progetto (albero), Diario; IT/EN |
| Backend | **Node.js 24 + `node:http`** (nessun framework) | `server/http.mjs`, `repository.mjs`, moduli per dominio |
| Accesso dati | **`pg` puro** (unica dipendenza runtime, no ORM) + astrazione `Storage` (driver SQLite/pg) | query SQL esplicite, migrazioni versionate |
| Database | **PostgreSQL (Neon, `eu-central-1`)** in produzione; **SQLite** in sviluppo/test | stesso contratto via `Storage` |
| Identità | **Locale**: email+password (`scrypt`), sessioni cookie `HttpOnly`, ruoli per cantiere (owner/editor/verifier/viewer), signup self-service con approvazione | niente provider OIDC per ora |
| File | **iDrive e2 S3**, bucket `siteassistant` | client SigV4 hand-rolled (`node:crypto`), readback SHA-256 |
| Verifiche | Test dominio + integrazione (SQLite e pg) + parità | `npm test`, `npm run test:pg`, `npm run test:schema` |

**Nessuna dipendenza runtime oltre `pg`.** Il backend è intenzionalmente senza framework/ORM.

## Flusso

```mermaid
flowchart LR
    U[Browser: interfaccia web] -->|HTTPS| A[API: node:http + pg]
    U -->|Login| A
    U -->|app shell + cache letture| SW[Service Worker]
    U -->|coda scritture| IDB[(IndexedDB: coda + mirror offline)]
    IDB -->|Background Sync (rete ok)| A
    A --> P[(PostgreSQL / Neon)]
    A --> O[Object storage S3 iDrive e2]
```

Il backend controlla identità, cantiere, ruolo e modulo prima di ogni operazione; credenziali DB e S3 restano solo sul server. La decisione vincolante avviene nel backend.

**Offline-first (incremento 15, spec pronta):** senza rete il browser carica l'app dalla cache del Service Worker, legge i dati già aperti e accoda le scritture (attività, diario, foto) in IndexedDB; al ritorno della linea il Background Sync replaya la coda con idempotenza (`Idempotency-Key`) e last-write-wins; le transizioni restano server-side.

## Moduli implementati (nucleo)

| Modulo | Tabella app | Migrazione | Stato |
| --- | --- | --- | --- |
| Cantieri | `sites` | 001 | ✅ UI |
| Attività (state machine) | `tasks`, `task_events` | 001, 004 | ✅ UI (board/elenco) |
| Diario (giorno operativo) | `diary` | 001, 002 | ✅ UI |
| Autenticazione | `users`, `sessions`, `site_members` | 005 | ✅ UI (login) |
| Signup self-service | `signup_requests` | 006 | ✅ API |
| Allegati | `attachments` | 007 | ✅ API |
| WBS | `project_structure` | 008 | ✅ UI (albero) |
| Presenze | `employees`, `work_days` | 009 | ✅ API |
| Avanzamento | `site_progress_items` | 010 | ✅ UI (barre, step pesati, ore pianificate) |
| Deviazioni | `deviations`, `deviation_links` | 011 | ✅ UI (bacheca, dettaglio, riconciliazione) |
| Prenotazioni ore | `time_bookings` | 012 | ✅ UI (ore sorgente e app, scostamento) |
| Impatti economici | `cost_impacts`, `cost_impact_deviations` | 013 | ✅ UI |

**UI attuale:** Panoramica (widget configurabili per utente), Cantieri, Attività (bacheca, elenco, vista leggera), Struttura progetto (WBS), Diario, Avanzamento, Deviazioni (con pannello di riconciliazione), Prenotazioni ore, Impatti economici, Attrezzature, Idoneità, HSE, Report stampabile. Il frontend espone anche il link al manuale e funziona offline su attività e diario, con coda di scritture sincronizzata al ritorno della rete.

## Regola del giorno operativo

`operational_date` con taglio configurabile (default 06:00, fuso `Europe/Rome`): il giorno operativo D va dalle 06:00 di D alle 05:59 di D+1; il turno notturno appartiene al giorno in cui è iniziato. Funzione pura `operationalDate` (Node `Intl`) + test DST.

## Ingest

6 famiglie sorgente reali (dossier privato `sa-handoff/`, mai nel repo pubblico), mappate in `source_snapshot` e promosse a `app` in modo **idempotente** via binding espliciti (`wbs_import_sources`, `hr_import_sources`, …):

| Famiglia | Righe | → app |
| --- | --- | --- |
| Employees | 1.249 | `employees` |
| Time Schedule | 2.322 | `project_structure` (WBS) |
| Site Progress Items | 2.320 | `site_progress_items` (identità unresolved) |
| Daily Log | 291 | — |
| Work Days | 48.398 | `work_days` |
| Deviations | 19.747 | `deviations` |

Identità: `source_uuid ↔ internal_id` via `ingest.entity_keys`; righe importate immutabili; annotazioni interne per identità persistente; reporting sull'ultimo bundle completo. **Nessun dato reale importato in produzione** (demo su dati sintetici).

## Hosting e deployment

- **Backend**: systemd `siteassistant-api` sul VPS Hostinger, dietro Traefik (`api.siteassistant.asassi.cloud`). Riavvio = migrazioni applicate su Neon.
- **Database**: **Neon** (`eu-central-1`), TLS; PostgreSQL 18 locale solo per i test (`test:pg`).
- **Frontend**: nginx (container `siteassistant-demo`), `siteassistant.asassi.cloud` con basic auth.
- **File**: iDrive e2 S3, bucket `siteassistant` (env `S3_*` dedicate, non il bucket di backup).
- **Manuale**: `docs-site/` (Astro+Starlight) → GitHub Pages (`as76.github.io/SiteAssistant`), aggiornato automaticamente dal job docs.

Sviluppo/staging/produzione hanno database, credenziali e bucket separati. Solo dati sintetici nel repo pubblico.

## Prossimi passi

1. **Pilot** su un cantiere reale: due professionisti, sei settimane (`specs/pilot-brief.md` nel vault).
2. **Gate CI** già attivo: suite su ogni push e pull request, SQLite e PostgreSQL reale.
3. **Responsabili collegati agli account** (#56) e poi **schermata «Oggi» su mobile** (#57).
4. **Audit trail append-only** per HSE, certificazioni e attrezzature (#52), prerequisito per l'uso aziendale.
5. Seguito: ingest reale (#5), storico di stato delle deviazioni (#50), perimetro per area (#48), viste reporting (#6), Google OAuth (#1).
6. Logistica/procurement (#30) = milestone successiva.

Le decisioni di perimetro restano documentate nel vault (blueprint/kanban), non qui.
