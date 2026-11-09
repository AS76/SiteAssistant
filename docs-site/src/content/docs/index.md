---
title: Benvenuto
description: Il manuale di SiteAssistant. Come usare l'applicazione in cantiere.
template: splash
hero:
  tagline: Il punto di controllo del cantiere. Cantieri, attività, verifiche e diario in un'unica applicazione.
  image:
    file: ../../assets/hero-dashboard.jpg
    alt: Illustrazione di un responsabile di cantiere che consulta una lavagna di avanzamento su tablet
  actions:
    - text: Inizia dalla guida
      link: guida/accesso/
      icon: right-arrow
    - text: Esplora i moduli
      link: moduli/attivita/
      variant: minimal
---

import { CardGrid, LinkCard } from '@astrojs/starlight/components';

Questa documentazione spiega **come si usa SiteAssistant in cantiere**: cosa puoi fare, passo dopo passo, e cosa no. È scritta per chi lavora sul campo — Site Manager, capisquadra, verificatori — e per chi amministra utenti e cantieri.

Se sai già cosa cerchi, usa la **ricerca** in alto: indicizza tutte le pagine, in italiano e in inglese.

<CardGrid>
  <LinkCard
    title="Accesso e account"
    description="Come si entra, come si richiede un account e come si gestisce la password."
    href="guida/accesso/"
  />
  <LinkCard
    title="Cantieri"
    description="Creare un cantiere, selezionarlo, capire i ruoli."
    href="moduli/cantieri/"
  />
  <LinkCard
    title="Attività e verifiche"
    description="Stati, passaggi, evidenze e separazione tra esecutore e verificatore."
    href="moduli/attivita/"
  />
  <LinkCard
    title="Diario di cantiere"
    description="Giorno operativo, turni, piano e consuntivo."
    href="moduli/diario/"
  />
  <LinkCard
    title="Struttura progetto (WBS)"
    description="Consultare la gerarchia dei lavori importata dal Time Schedule."
    href="moduli/wbs/"
  />
</CardGrid>

## Da dove partire

- **Sono un nuovo utente:** [Accesso e account](guida/accesso/), poi [Funzioni comuni](guida/funzioni-comuni/).
- **Devo caricare il primo cantiere:** [Cantieri](moduli/cantieri/) e [Configurare un cantiere](amministrazione/configurare-cantiere/).
- **Devo capire chi può fare cosa:** [Utenti e ruoli](amministrazione/utenti-e-ruoli/).
- **Voglio sapere cosa manca ancora:** [Stato del prodotto](note/rilascio/).

:::caution[Dati reali]
La versione attuale è una demo operativa. Non inserire informazioni riservate, credenziali o dati contrattuali. Vedi [Stato del prodotto](note/rilascio/) per il perimetro esatto.
:::
