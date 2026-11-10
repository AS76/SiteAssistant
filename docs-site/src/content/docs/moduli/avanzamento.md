---
title: Avanzamento di cantiere
description: Consultare le voci di avanzamento importate, assegnare un tipo e registrare il completamento degli step.
---

La vista **Avanzamento** mostra le voci di avanzamento del cantiere selezionato. I dati di base arrivano dall'export planning; il completamento degli step si registra nell'applicazione.

## L'elenco

Ogni riga riporta la descrizione, la sezione, l'area PLC, la percentuale di avanzamento e le ore prenotate. Il filtro in alto limita l'elenco alle voci collegate a un nodo della struttura progetto.

Apri una riga per vedere il dettaglio.

## Il dettaglio

Il dettaglio mostra:

- descrizione, sezione e area PLC;
- la voce WBS collegata, se esiste;
- l'assegnatario;
- l'avanzamento e l'avanzamento pianificato;
- lo scostamento calcolato dalla sorgente;
- le ore prenotate;
- inizio e fine pianificati, inizio effettivo e ritardo previsto;
- i contrassegni **File presenti**, **Note presenti** e **Deviazioni presenti**.

I campi importati sono in sola lettura. L'unico dato che scrivi è il completamento degli step.

## Tipi di avanzamento e pesi

Un **tipo di avanzamento** descrive come si misura il lavoro di una voce: un elenco di step, ognuno con un peso. I pesi sono percentuali della voce e devono sommare **100**.

Esempio: quattro step con pesi 30, 30, 20 e 20. Se la somma è 99 o 101, il tipo viene rifiutato.

Un tipo si crea via API ed è riservato agli owner. Nell'interfaccia un owner può assegnare o togliere il tipo a una voce; un owner o un editor può registrare il completamento degli step.

## Registrare il completamento

1. Apri il dettaglio della voce.
2. In **Registra completamento step**, inserisci per ogni step una percentuale da 0 a 100.
3. Premi **Salva step**.

L'avanzamento della voce viene ricalcolato come media pesata degli step. Se una voce ha un tipo assegnato ma nessuno step registrato, l'avanzamento calcolato è **0**: il valore importato non viene usato.

Ogni salvataggio aggiunge una registrazione allo **storico**. Lo storico non viene riscritto e le curve di avanzamento si calcolano da lì, non dagli import.

## Chi può fare cosa

| Azione | Ruolo |
| :-- | :-- |
| Consultare le voci e il dettaglio | Tutti i membri del cantiere |
| Assegnare o togliere un tipo di avanzamento | owner |
| Registrare il completamento degli step | owner, editor |
| Creare o eliminare un tipo di avanzamento | owner, solo via API |

## Cosa non è ancora disponibile

- Creare o modificare un tipo di avanzamento dall'interfaccia.
- Modificare i campi importati di una voce.
- Creare o eliminare voci di avanzamento dall'interfaccia: arrivano dall'import.

Per il rapporto tra avanzamento e struttura progetto vedi [Struttura progetto (WBS)](../wbs/). Per i dati grezzi vedi [API REST](../../riferimento/api/).
