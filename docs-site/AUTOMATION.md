# Documentation automation

The published manual is `docs-site/` (Astro + Starlight). Italian lives at the root, English under `en/` with the same slugs.

## What is automatic

| Step | Where | Trigger |
| :-- | :-- | :-- |
| Build, link check, publish | `.github/workflows/docs.yml` | Push to `main` touching `docs-site/**` |
| Stale detection | `.github/workflows/docs-freshness.yml` | Weekly, or manual dispatch |
| Content update | OpenClaw job, clone `/root/projects/siteassistant-docs-bot` | Every 30 minutes; acts only when code is newer than the manual |

## Rules for the content update job

1. Work only inside `docs-site/src/content/docs/` (and `docs-site/src/content/docs/en/`). Never touch `app/`, `server/`, `database/`, `tests/`.
2. Update the pages affected by the commit range; keep the existing structure and voice. Do not invent features, screenshots or numbers.
3. Italian page and English page must both be updated, same slug.
4. `npm run build` must pass, including the internal link check. If it fails, revert the edits and open/refresh the `docs-stale` issue instead.
5. Commit message: `docs(auto): <what changed>`, body listing the pages.
6. If a change cannot be documented without UI screenshots or a product decision, leave a `docs-stale` issue describing exactly what is missing.
7. Add an entry to `note/novita.md` and `en/note/novita.md` only when the change is visible to users.

## Local commands

```sh
cd docs-site
npm ci
npm run dev      # http://localhost:4321/SiteAssistant/
npm run build    # build + link check
```

## Hosting

GitHub Pages, project site `https://as76.github.io/SiteAssistant/`. `DOCS_SITE` and `DOCS_BASE` override the domain at build time; a custom domain needs a `CNAME` record and the Pages setting, plus `DOCS_BASE=/`.

## Manual override

Any human commit touching `docs-site/` is authoritative: the next automatic run resets the bot clone to `origin/main` and starts from there.
