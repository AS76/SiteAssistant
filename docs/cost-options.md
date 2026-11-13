# Multi-user demo — cost assessment

Status: **SUPERSEDED (2026-11-10).** Railway set aside: the operational DB is **Neon** (`eu-central-1`), the app runs on the Hostinger VPS. This document remains only as a historical cost comparison. See [architecture.md](architecture.md).

## Goal

A demo with an HTTPS URL, controlled access, shared persistent data and synthetic initial data. Limit recurring costs and rewriting work, while maintaining a path towards the operational pilot.

Updated constraint: the demo uses separate services; reuse of servers shared with other workloads is outside the current scope.

## Alternatives

The current choice favors a single provider for the application and database, with GitHub integration. Absolute minimization of recurring fees remains subordinate to ease of managing the test environment.

The document archive integrates through S3 compatibility: assess costs for requests, reads/transfers, derivatives and copies without assuming file duplication on Railway. Complementary internal use focuses development on imports and views, avoiding rebuilding the source system's official workflows. Profiles to implement depend on the samples actually verified.

| Option | Incremental hosting cost | Operational work and conditions |
| --- | --- | --- |
| **Choice: application and PostgreSQL in the same Railway project** | App, database and storage plan and usage to be estimated | A single platform for deployment, variables, network and services; backup and restore to be verified on the actual plan |
| Static frontend and managed backend integrated with PostgreSQL, login and storage | Potentially 0 euros/month within free-plan quotas and conditions to be verified | Assess, for example, Cloudflare Pages with Supabase; define access policies, server operations and transactions |
| App with a dedicated Node.js backend and managed PostgreSQL | Minimum and usage to be estimated; free use not assumed | Assess, for example, Railway with Neon; retain the application API and verify quotas, suspension and recoverability |
| New hosting and database on paid plans | Recurring/minimum fee and usage to be estimated | More explicit budget, capacity and management dependent on the plan; official price lists must be compared before choosing |

PostgreSQL has no license fee. Cost depends on compute, memory, disk, transfers, backups, ancillary services and maintenance. Changing the engine does not guarantee savings on the project total.

## Reducing development cost

- Initially retain the existing interface's HTML/CSS and JavaScript modules. Moving to React is not a prerequisite for publishing a demo with a backend.
- Run a single Node.js application for frontend and API, with separate PostgreSQL in the same Railway project. The static frontend alone does not replace server logic, authorization and transactions.
- Reuse domain rules after separating simulated identities, server authorization and persistence. The demo's person selector does not become an authentication mechanism.
- Use PostgreSQL from the first shared backend, with migrations and tests, comparing the overall cost of the services hosting it.
- Start with invitation-only access and an authentication method maintained by an appropriate library or provider, to be chosen based on conditions and costs; no handcrafted authentication.
- Retain IT/EN, synthetic data, backups and essential reports. Add modules incrementally; attachments, large imports and offline have separate development costs.

## Current decision

Proceed with the technical design for Railway, using its PostgreSQL service in the same project as the application. This avoids introducing a second provider for the database. The alternatives in the table remain a cost comparison and are not the selected architecture.

Before activation, check current pricing, any plan minimum, compute/RAM usage, volumes, traffic and backups. Define a budget and spending notifications where available. To start, use a single cloud test environment with a few users, limits consistent with the trial and synthetic data. Free use, included backups and absence of idle consumption are not assumed.

Before publication: verify isolation, login, database access, persistent storage, exportability and a working restore. All demonstration data remains synthetic. Initially use the service's subdomain if compatible with the use case; a new domain has a separate cost.

## Data needed for an estimate

Number of concurrent users, file volume, need for continuous availability, domain, maximum budget and maintenance cost/time. For external services: current price list, plan permitted for the type of use, quotas and overage policies.
