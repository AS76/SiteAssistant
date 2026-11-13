# Resuming development with Codex

> ⚠️ **SUPERSEDED (2026-11-10).** Describes the initial state (localStorage demo, no backend). The actual state is in [architecture.md](architecture.md): `node:http` + `pg` + Neon backend, 6 core modules, migrations 001–013, local auth, S3 attachments.

## Repository state

A local IT/EN web demo is implemented with sites, tasks, verification flow, diary, browser persistence, JSON backup, CSV and printing. There is not yet an application backend, real login, operational importer, S3 connection or Railway deployment.

The chosen direction is an internal app complementary to a source system. Railway will host the application and PostgreSQL in the same project. Files will be linked through S3-compatible storage; MCP is an optional channel, to be verified on the system that makes it available.

## Starting from the code

On a new machine, clone the repository; if the checkout already exists, reuse it while preserving local changes:

```sh
git clone https://github.com/AS76/SiteAssistant.git
cd SiteAssistant
```

Use Node.js 24 for development tools and Python 3 for the static server:

```sh
npm ci
npm test
npm run test:schema
python3 -m http.server 8000 --bind 127.0.0.1 --directory app
```

Open port 8000 in the local browser. The demo does not share data between devices. The static server remains a foreground process; tests must be run beforehand or in another console.

## Documents to read

1. [Requirements and current behavior](requirements.md).
2. [Architecture and database](architecture.md).
3. [Technical infographic and main areas](architecture-overview.html).
4. [Planning, layouts and maps](planning-layouts.md).
5. [Import and document archive](import-storage.md).
6. [SQL schema and checks](../database/README.md).
7. [Hosting choices and costs](cost-options.md).

## Private data and profiles

The repository contains no real exports, analytical dossiers or account- and organization-specific mappings. Access to these materials must be provided by the user through an authorized private channel; it cannot be reconstructed from the public repository and must not be searched for automatically on the host system.

Continuing the importer requires the private mapping profile and the selected files, stored outside the checkout. The application code must receive privately configured paths or references and validate the profile. A private profile must not be copied into public tests: create synthetic fixtures with the same technical constraints and no real text or identifiers.

The published SQL schema uses canonical names, including generic names for custom fields. The mapping must be reviewed against these names; an old profile may need adaptation. Do not automatically apply a private dossier or an analysis script as a production migration.

## Proposed next increment

1. Introduce Node.js/TypeScript APIs and local development configuration, with automated tests and synthetic data.
2. Integrate the ingestion schema and application model into versioned migrations; define identities, access and contexts.
3. Implement preview and mapping for one export family; keep raw data, snapshots and internal updates separate. Work on real files only in the authorized private context.
4. Gradually replace localStorage with APIs, preserving demo behavior and handling version conflicts.
5. Integrate authentication and S3 reads for selected files; then prepare the Railway deployment, checking the plan and configuration.

The frontend does not need to be rewritten immediately. Gantt planning, percentage/quantity/yes-no progress, PDF and images are designed requirements; not features already available. CAD compatibility requires verification and is not assumed from uploading the file alone.

## Available checks

- `npm test`: demo rules and export formats.
- `npm run test:schema`: PostgreSQL schema with synthetic data, in memory.
- `node tests/browser.cjs`: desktop/mobile flows; requires Playwright and Chromium. Configure `SITEASSISTANT_URL` if the server uses another port and `CHROMIUM_PATH` if necessary.

The resumption prompt can ask: “Read AGENTS.md and docs/development-handoff.md. Continue with the first backend increment using synthetic data, without deployment and without publishing private materials”.
