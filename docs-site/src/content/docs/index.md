---
title: Benvenuto
description: Manuale operativo e riferimento tecnico di SiteAssistant.
template: splash
hero:
  tagline: Il punto di controllo del cantiere. Cantieri, attività, verifiche e diario in un'unica applicazione.
  actions:
    - text: Inizia dalla guida
      link: guida/accesso/
      icon: right-arrow
    - text: Vai al riferimento API
      link: riferimento/api/
      variant: minimal
---

import { Card, CardGrid, LinkCard } from '@astrojs/starlight/components';

Questa documentazione descrive **SiteAssistant** così com'è oggi: cosa fa, come si usa in cantiere e quali limiti ha. È pensata per chi lavora sul campo — Site Manager, capisquadra, verificatori — e per chi amministra utenti e cantieri.

Se sai già cosa cerchi, usa la **ricerca** in alto: indicizza tutte le pagine, in italiano e in inglese.

<CardGrid>
  <LinkCard
    title="Accesso e sessioni"
    description="Come si entra, cosa dura una sessione e come si esce."
    href="guida/accesso/"
  />
  <LinkCard
    title="Cantieri"
    description="Creare un cantiere, selezionarlo, gestire i membri."
    href="moduli/cantieri/"
  />
  <LinkCard
    title="Attività e verifiche"
    description="Stati, transizioni, evidenze e separazione tra esecutore e verificatore."
    href="moduli/attivita/"
  />
  <LinkCard
    title="Diario di cantiere"
    description="Giorno operativo, turni, piano e consuntivo."
    href="moduli/diario/"
  />
</CardGrid>

## Da dove partire

- **Sono un nuovo utente:** [Accesso e sessioni](guida/accesso/), poi [Funzioni comuni](guida/funzioni-comuni/).
- **Devo caricare il primo cantiere:** [Cantieri](moduli/cantieri/) e [Configurare un cantiere](amministrazione/configurare-cantiere/).
- **Devo capire chi può fare cosa:** [Utenti e ruoli](amministrazione/utenti-e-ruoli/).
- **Integro l'applicazione:** [API REST](riferimento/api/).

:::caution[Dati reali]
La versione attuale è una demo operativa. Non inserire informazioni riservate, credenziali o dati contrattuali. Vedi [Stato del prodotto](note/rilascio/) per il perimetro esatto.
:::
