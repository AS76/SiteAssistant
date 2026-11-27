# Product Vision & Functional Architecture — Three Pillars

Stato: **direzione di prodotto confermata dall'owner il 27/11/2026**.
Card di riferimento: `d57ae22c`.
Natura del documento: orientamento architetturale. **Non** è un mandato di refactoring, di riorganizzazione dell'interfaccia né di modifica delle priorità correnti.

## 1. Perché tre pilastri

SiteAssistant cresce per incrementi scelti da un bisogno operativo reale. È il modo giusto di costruire, ma produce una deriva prevedibile: moduli che si somigliano senza saperlo, registri paralleli dello stesso oggetto, funzioni duplicate in domini diversi.

I tre pilastri non sono un organigramma né una nuova navigazione. Sono un **criterio di appartenenza**: dato un requisito, si sa in quale dominio vive, chi ne è proprietario e — soprattutto — se sta duplicando qualcosa che esiste già.

## 2. I tre pilastri

| Pilastro | Ambito | Domanda a cui risponde |
| --- | --- | --- |
| **Site Execution** | WBS, attività, avanzamento, risorse, impegni settimanali, deviazioni | Cosa va fatto, da chi, a che punto è |
| **Site Logistics** | Procurement, spedizioni, materiali, inventario, asset e attrezzature | Cosa arriva, dove si trova, cosa è installato |
| **Site Assurance** | HSE, qualità, ispezioni, evidenze, verifiche, handover, Permit to Work | Come dimostro che è stato fatto bene e chi lo certifica |

I tre pilastri si toccano ma non si sovrappongono: un'attività (Execution) consuma materiale (Logistics) e produce evidenza (Assurance). Il materiale non è un'attività, e l'evidenza non è un movimento di magazzino.

## 3. Le fondamenta condivise

Luoghi · persone · imprese · identità · permessi · diario probatorio · giurisdizioni · documenti · audit trail.

Sono **fondamenta, non pilastri**. Non appartengono a un dominio perché tutti e tre ne dipendono nello stesso modo: un luogo non è "di logistica", è il posto in cui attività, materiali e ispezioni accadono.

La conseguenza operativa è una regola semplice: **una fondazione si estende per un bisogno trasversale, non per comodità di un singolo pilastro.** Se un pilastro chiede di cambiare il modello dei luoghi per sé, la richiesta va valutata sugli altri due.

## 4. Mappatura verificata sul codice

Riferimento: commit `0e44e3c`, migrazioni fino alla 057.

| Pilastro | Tabelle e moduli esistenti | In roadmap |
| --- | --- | --- |
| Execution | `project_structure`, `tasks` / `task_events`, `site_progress_items`, `time_bookings`, `employees` / `work_days`, `workforce_names` / `workforce_presence`, `deviations` / `deviation_links`, `cost_impacts` | ciclo dell'impegno settimanale (realizzato), misura e valore |
| Logistics | `purchase_orders` / `purchase_order_items`, `packages` / `package_items`, `shipments` / `shipment_receipts`, `assets` / `asset_positions`, `tools` | Site Materials & Inventory, identificazione QR |
| Assurance | `hse_events`, `hse_assets`, `hse_inspections`, `certifications` | qualità e accettazione, handover, Permit to Work |
| Trasversali | `sites`, `places`, `users` / `sessions`, `site_members`, `member_module_access`, `attachments`, `audit_events`, `diary` / `diary_versions`, `signup_requests`, `invitations` | registro documenti versionato, moduli paese |

La mappatura mostra che i tre pilastri esistono già di fatto. La visione li rende espliciti, così che le scelte future siano coerenti invece di casuali.

## 5. Punti di duplicazione da prevenire

Non sono ipotesi: sono incroci già visibili nel codice o nelle specifiche approvate.

1. **`tools` vs `hse_assets`.** Logistics possiede l'identità dell'attrezzatura, Assurance ne gestisce verifiche e idoneità tramite `tool_id`. È il primo test concreto del modello "un oggetto fisico, una identità". Vale lo stesso per gli asset installati, con il futuro `asset_id` in `hse_assets`.
2. **Ispezione HSE vs ispezione qualità.** Esiste `hse_inspections` con template ed esiti. Qualità e accettazione (ITP, WIR, NCR) userà lo stesso meccanismo di evidenza. Due concetti di ispezione, un solo motore: se non si decide ora, nascono due registri paralleli che nessuno riconcilierà.
3. **Diario probatorio.** È una fondazione condivisa, e sta ricevendo input da più parti: sessioni di inventario, handover, ispezioni. Il rischio non è l'uso, è l'abuso: diventare il contenitore di tutto e perdere il carattere probatorio che lo rende utile.
4. **Luoghi come ubicazioni di magazzino.** Logistics userà `places` per depositi, container e scaffali. Se `places` cresce per esigenze di magazzino, cambia il modello per tutti e tre i pilastri, non solo per uno.
5. **Allegati e registro documenti.** `attachments` copre oggi sei tipi di entità e non asset e luoghi; il registro documenti versionato non deve diventare un secondo sistema di allegati accanto al primo.
6. **Permessi per modulo o per pilastro.** Oggi sono strict `logistics`, `workforce_names` e `workforce_presence`: senza una concessione esplicita restano chiusi. Gli altri moduli no. `materials` non è ancora un modulo: è un requisito futuro, non un permesso attivo. La visione a pilastri suggerisce di ragionare per pilastro; il modello attuale è per modulo. È una decisione aperta, non un cambiamento da fare adesso.

## 6. Come usare questa visione

- **Davanti a un requisito nuovo**: stabilire il pilastro, verificare che non esista già in un altro, e solo allora progettare.
- **Davanti a un'estensione di una fondazione**: valutare l'effetto sugli altri due pilastri prima di approvarla.
- **Davanti a un modulo che sembra duplicato**: non fondere per entusiasmo. La fusione di due registri è più costosa della loro convivenza, se la convivenza è dichiarata e collegata.
- **Davanti a una proposta di riorganizzazione dell'interfaccia**: la visione non la impone. La navigazione attuale resta valida finché non esiste un motivo operativo per cambiarla.

## 7. Cosa questa visione non è

Non è un piano di lavoro, non è una roadmap e non è un'autorizzazione. Non prevede refactoring, rinumerazioni, migrazioni o spostamenti di moduli. Non cambia le priorità: Luoghi e Asset 2a e 2b restano davanti a tutto.

Ogni iniziativa che nasce da qui passa da una card propria, con perimetro, dipendenze e autorizzazione dell'owner.
