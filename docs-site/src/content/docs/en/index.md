---
title: Welcome
description: SiteAssistant user manual and technical reference.
template: splash
hero:
  tagline: The site control point. Sites, tasks, verification and the site diary in one application.
  actions:
    - text: Start with the guide
      link: guida/accesso/
      icon: right-arrow
    - text: Go to the API reference
      link: riferimento/api/
      variant: minimal
---

import { CardGrid, LinkCard } from '@astrojs/starlight/components';

This documentation describes **SiteAssistant** as it is today: what it does, how it is used on site, and what its limits are. It is written for the people doing the work — site managers, foremen, verifiers — and for whoever administers users and sites.

If you know what you are looking for, use **search** above: it indexes every page in Italian and English.

<CardGrid>
  <LinkCard
    title="Sign in and sessions"
    description="How to sign in, how long a session lasts, how to sign out."
    href="guida/accesso/"
  />
  <LinkCard
    title="Sites"
    description="Create a site, select it, manage its members."
    href="moduli/cantieri/"
  />
  <LinkCard
    title="Tasks and verification"
    description="Statuses, transitions, evidence and the separation between executor and verifier."
    href="moduli/attivita/"
  />
  <LinkCard
    title="Site diary"
    description="Operational day, shifts, plan and actuals."
    href="moduli/diario/"
  />
</CardGrid>

## Where to start

- **I am a new user:** [Sign in and sessions](guida/accesso/), then [Common features](guida/funzioni-comuni/).
- **I need to set up the first site:** [Sites](moduli/cantieri/) and [Configure a site](amministrazione/configurare-cantiere/).
- **I need to know who can do what:** [Users and roles](amministrazione/utenti-e-ruoli/).
- **I am integrating the application:** [REST API](riferimento/api/).

:::caution[Real data]
The current version is an operational demo. Do not enter confidential information, credentials or contractual data. See [Product status](note/rilascio/) for the exact scope.
:::
