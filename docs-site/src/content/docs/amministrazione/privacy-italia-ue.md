---
title: Protezione dei dati in Italia e nell'Unione europea
description: Riferimenti al GDPR e al Codice Privacy italiano per installazioni autonome di SiteAssistant.
---

> Questa pagina è un riferimento generale, **non** una dichiarazione di conformità dell'applicazione né un'informativa privacy del datore di lavoro. La demo pubblica è riservata a dati sintetici.

## Quadro normativo

In Italia e nell'Unione europea il riferimento principale è il **Regolamento (UE) 2016/679 (GDPR)**. In Italia si aggiunge il **D.Lgs. 196/2003 (Codice in materia di protezione dei dati personali)**, come modificato, e possono rilevare norme settoriali o sul rapporto di lavoro, comprese le regole in materia di salute e sicurezza.

L'autorità di controllo italiana è il **Garante per la protezione dei dati personali**. L'applicazione della normativa dipende dal trattamento concreto: non basta scegliere `jurisdiction: IT` o utilizzare l'interfaccia italiana.

## Verifiche per un'azienda che installa SiteAssistant

| Tema | Cosa documentare |
| --- | --- |
| Principi (art. 5) | Finalità specifiche, minimizzazione, accuratezza, conservazione limitata e responsabilizzazione. |
| Base giuridica (art. 6) | La base per ciascuna finalità, in particolare per presenze, ore, tracciamento delle attività e condivisione con altri soggetti. |
| Dati particolari (art. 9) | Una condizione ulteriore per eventuali dati sanitari e garanzie adeguate. Non assumere che un consenso del lavoratore sia automaticamente libero o appropriato. |
| Informative e diritti (artt. 12–22) | Informativa dell'organizzazione, gestione delle richieste e limiti o eccezioni applicabili. |
| Privacy by design e sicurezza (artt. 25 e 32) | Accessi, allegati, backup, registri, dispositivi offline e misure commisurate al rischio. |
| Responsabili (art. 28) | Accordi e istruzioni se cloud provider, gestori o supporto trattano dati per conto dell'azienda. |
| Registro/DPIA (artt. 30 e 35) | Valutare documentazione dei trattamenti e DPIA dove il rischio lo richiede. Le eventuali esenzioni vanno verificate, non presunte. |
| Incidenti (artt. 33–34) | Procedure per rilevamento, valutazione e notifiche dovute. |
| Trasferimenti (capo V) | Dove vanno dati o accessi a fornitori fuori dallo SEE e quali condizioni si applicano. |

## Dati dei lavoratori e idoneità

Registrare una semplice scadenza formativa non equivale a conservare informazioni mediche. Tuttavia, un campo che identifica una persona e il suo stato di idoneità sanitaria può costituire **dato relativo alla salute**; l'assenza di una diagnosi non elimina automaticamente questa qualificazione.

Nel modulo Idoneità sono disponibili categorie relative a visite mediche, esiti e note. Le aziende devono valutare con il proprio DPO o consulente e, ove necessario, con il medico competente, quali informazioni possano essere legittimamente comunicate e da chi. Non utilizzare note libere e fotografie per raccogliere dettagli clinici non necessari.

Le eventuali obbligazioni di documentazione HSE non giustificano, da sole, l'accesso generalizzato a qualunque dato sanitario da parte di committenti o contractor.

## Limiti tecnici rilevanti oggi

SiteAssistant dispone di ruoli e permessi per modulo, ma non di una procedura completa e automatica per cancellazione, retention e risposta a richieste relative ai dati di una persona. La conservazione di audit, backup e cache locali richiede una valutazione specifica. L'azienda deve completare la [checklist prima dell'uso reale](../privacy-checklist/) e non equiparare il soft delete alla cancellazione totale.

## Fonti ufficiali

- [GDPR UE in italiano — EUR-Lex](https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=it)
- [Codice Privacy — Normattiva](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2003-06-30;196)
- [Garante — Principi fondamentali del trattamento](https://www.garanteprivacy.it/web/guest/home/principi-fondamentali-del-trattamento)
- [Garante — provvedimento 26 marzo 2026, dati dei lavoratori](https://www.garanteprivacy.it/web/guest/home/docweb/-/docweb-display/docweb/10243180)
- [EDPB — controller e processor](https://www.edpb.europa.eu/sme/learn-the-basics/data-controller-or-data-processor_en)

*Riferimenti verificati il 20 novembre 2026. È necessaria una valutazione locale aggiornata prima di trattare dati reali.*
