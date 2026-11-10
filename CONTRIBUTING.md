# Contributing to SiteAssistant

Thank you for your interest. SiteAssistant is a small open project, and we are glad to have you here — whether you write code, work on construction sites, or just care about how the tool feels to use.

Contributing does **not** mean writing code. A well-described issue, a thoughtful proposal, or a conversation about a real site workflow is just as valuable as a pull request.

## First, understand the project

- **README.md** — what the project is and its current state.
- **Documentation** — <https://as76.github.io/SiteAssistant/> (Italian at the root, English under `/en/`). The source is in `docs-site/`.
- **Architecture** — `docs/architecture.md` describes the actual stack and modules.

SiteAssistant is built for people working on construction and industrial sites. Start from that problem, not from the technology.

## Ways to contribute

### Report a problem or propose an idea

Open a [GitHub Issue](https://github.com/AS76/SiteAssistant/issues). A useful issue includes:

- What you were trying to do.
- What happened instead.
- Steps to reproduce, if you can.
- The context (device, browser, whether you were offline).

You do not need to be a developer to report a problem. Clear wording matters more than technical vocabulary.

### Find something to work on

- Look for issues, especially any labelled for newcomers.
- Prefer small, well-scoped changes for a first contribution.
- If you are unsure whether an idea fits, open an issue and ask before writing code.

### Propose a change (Pull Request)

1. Fork the repository and create a branch.
2. Make a focused change — one concern per pull request.
3. Follow the existing style of the files you touch.
4. Run the relevant checks before opening the PR (see below).
5. Describe what you changed and why, and how you tested it.

### Contribute as a site or construction professional

You know the real workflows better than most developers do. Useful contributions include:

- Describing a real site process and where the current tool falls short.
- Reviewing whether the task states and diary flow match how sites actually work.
- Flagging what a site manager or commissioning engineer would expect but does not find.

### Contribute to UX and testing

- Try the application on a phone and on a desktop.
- Report confusing flows, dead ends, and accessibility problems.
- Suggest concrete improvements — screenshots or sketches help, but a clear description is enough.

## Checks before opening a pull request

```sh
npm test            # domain + API tests (SQLite)
npm run test:schema # schema tests
npm run test:pg     # PostgreSQL driver (requires a test database)
```

For documentation changes under `docs-site/`:

```sh
cd docs-site
npm ci
npm run build       # builds the site and checks internal links
```

Keep the change scoped. Do not include unrelated edits in a pull request.

## Working together

- Be respectful and constructive. Disagreement about an idea is fine; personal criticism is not.
- Assume good intent, including from people whose first language is not English or Italian.
- Reviews may take time. This is a side project with no full-time maintainers, and no response time is promised.
- No paid work, assignments, or recognition are offered through contributions.

We are not trying to convince anyone that SiteAssistant is already perfect. We are inviting capable and curious people to help build something that can become genuinely useful.
