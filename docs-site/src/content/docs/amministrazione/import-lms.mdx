---
title: Importare un export di pianificazione
description: Caricare un file xlsx, vedere in anteprima cosa cambierebbe e confermare l'import.
---

L'import porta in SiteAssistant i dati esportati da planning. Si parte sempre da un'**anteprima**: finché non confermi, l'applicazione non scrive nulla.

## Chi può importare

L'import è riservato a **owner** ed **editor** del cantiere. Il pulsante **Importa export di pianificazione** compare nella **Panoramica**, accanto a **Nuova attività**.

## Il file

- Formato **xlsx**, esportato da planning.
- Dimensione massima **20 MiB**.
- Un file per famiglia di dati.

## Le sei famiglie

| Tipo di export | Cosa aggiorna |
| :-- | :-- |
| Dipendenti | Anagrafica del personale: numero, nome, impresa, qualifica, squadra, date |
| Presenze | Giorni lavorati, orari, ore e stato di origine |
| Time Schedule | Voci della struttura progetto, con codice, date e avanzamento pianificato |
| Avanzamento | Voci di avanzamento, con sezione, area PLC e percentuali |
| Deviazioni | Deviazioni con stato, priorità, date e importi |
| Diario | Voci di diario importate dal registro planning |

## I due passaggi

1. Premi **Importa export di pianificazione**.
2. Scegli il **Tipo di export** e il **File xlsx**, poi premi **Anteprima**.
3. Leggi il riepilogo **Cosa cambierebbe**.
4. Se i numeri tornano, premi **Conferma import**.

L'anteprima mostra cinque conteggi:

| Voce | Significato |
| :-- | :-- |
| nuove | Righe non presenti nel cantiere: saranno create |
| aggiornate | Righe esistenti con valori diversi: saranno sovrascritte |
| invariate | Righe identiche a quelle già presenti: nessuna scrittura |
| assenti (non toccate) | Righe presenti nel cantiere ma non nel file: **non vengono cancellate** |
| rifiutate | Righe non importabili, elencate con riga di origine e motivo |

Esempio: una riga di presenza con un numero dipendente che non esiste nel cantiere finisce tra le **rifiutate**; una voce già presente con gli stessi valori finisce tra le **invariate**.

## Come vengono riconosciute le righe

Ogni famiglia usa una chiave stabile dell'export:

- dipendenti: numero dipendente;
- presenze: data e numero dipendente;
- Time Schedule: codice WBS;
- avanzamento: descrizione, date pianificate, area PLC e sezione;
- deviazioni: numero deviazione;
- diario: data.

Una riga con la stessa chiave e valori diversi viene aggiornata. Una riga identica resta invariata.

## Righe rifiutate

Una riga viene rifiutata, e non applicata, quando:

- un dipendente della presenza non esiste nell'anagrafica del cantiere;
- l'identità di una voce di avanzamento è ambigua;
- lo stato di una deviazione non è riconosciuto;
- manca una cella obbligatoria.

Le righe rifiutate restano elencate nell'anteprima. Correggi l'export e ripeti l'import.

## Dopo la conferma

L'applicazione ricarica i dati del cantiere e aggiorna le viste. La Panoramica ricalcola i contatori e i grafici.

L'anteprima vale **15 minuti**: se scade, ripeti l'anteprima prima di confermare.

## Cosa non fa

- **Non cancella righe.** Le righe assenti restano nel cantiere e il conteggio delle righe rimosse applicate è sempre zero.
- **Non annulla un import** dall'interfaccia.
- **Non importa allegati**: i file restano fuori dall'export.
- **Non crea dipendenti**: una presenza con un numero dipendente sconosciuto viene rifiutata.

Per il formato dei dati e gli endpoint vedi [API REST](../../riferimento/api/). Per i ruoli vedi [Utenti e ruoli](../utenti-e-ruoli/).
