---
title: Stato del prodotto
description: Cosa è disponibile oggi, cosa manca e quali limiti vanno conosciuti prima dell'uso.
---

Questa pagina descrive la versione attualmente pubblicata. È deliberatamente esplicita su ciò che non esiste, per evitare aspettative sbagliate in cantiere.

## Disponibile nell'interfaccia

- Accesso con email e password, sessioni che durano 7 giorni.
- Richiesta autonoma di accesso e reset password, con approvazione da parte di un owner.
- Ruoli per cantiere: `owner`, `editor`, `verifier`, `viewer`.
- Creazione di cantieri riservata agli owner; codice univoco.
- Attività con esecutore e verificatore separati, priorità, scadenza, area, impresa e tipo ordinaria o correttiva; la vista **Attività leggere** chiude e riapre le ordinarie con un solo comando.
- Transizioni di stato con note, motivazioni e cronologia. Dal dettaglio dell’attività puoi verificare, respingere o riprendere il lavoro quando il comando è disponibile.
- Verifica separata: chi esegue non può chiudere il proprio lavoro.
- Diario per giorno operativo e turno, con piano, consuntivo, impedimenti e prossimo passo. Puoi registrare turni passati, correggere le voci e leggerne lo storico online secondo i [permessi del Diario](../../moduli/diario/).
- Foto e PDF allegati ad attività, voci di diario e deviazioni, anche trascinati dal desktop, fino a 15 MiB per file; gli eventi HSE accettano foto e PDF dalla finestra di modifica.
- Vista **Struttura progetto (WBS)** operativa: albero e tabella piatta, modifica dei nodi, collegamento delle attività e riconciliazione con l'export di origine; i nodi sintetici restano generati dal sistema.
- Viste **Deviazioni**, **Avanzamento**, **Prenotazioni ore** e **Impatti economici**.
- Vista **Attrezzature**: registro per appaltatore, stato e posizione, con inserimento, modifica ed eliminazione dall'interfaccia.
- Vista **Idoneità**: abilitazioni, visite mediche e formazione dei dipendenti, con scadenza, giorni residui e stato calcolato; leggono owner, editor e verificatori, scrivono owner ed editor.
- Vista **HSE**: registro separato di near miss, infortuni e osservazioni, con data, tipo, gravità, luogo, un conteggio di persone coinvolte e misure; nessun dato sanitario. Leggono owner, editor e verificatori, scrivono owner ed editor; gli eventi salvati accettano allegati e ogni apertura di un allegato HSE resta nel registro di audit.
- Vista **Logistica**: ordini di acquisto del cantiere con fornitore, data, righe, quantità, stati e collegamento alla struttura progetto, con inserimento, modifica e cambi di stato; le schede **Pacchi** e **Spedizioni** mostrano i colli imballati e le spedizioni con le ricezioni. Il modulo `logistics` è spento per impostazione predefinita e si concede dalla tabella **Accessi per modulo**; leggono tutti i membri con il modulo, scrivono owner ed editor. I cantieri dimostrativi contengono due ordini per cantiere.
- Vista **Reporting**: riepilogo in sola lettura dell'ultimo bundle completo per ambito di progetto, con conteggi per famiglia, data di export dichiarata, data e ora di caricamento e segnalazioni di qualità; solo conteggi, senza righe di dettaglio. Il modulo `reporting` è attivo per impostazione predefinita e si toglie dalla tabella **Accessi per modulo**; leggono tutti i ruoli, nessuno scrive. Richiede la connessione a un database di reporting configurata sul server.
- Avanzamento con tipi a step ponderati: i pesi devono sommare 100; il completamento si registra dall'applicazione. Ogni voce ha **ore pianificate** proprie o del nodo WBS collegato.
- **Lavoro prodotto** nella Panoramica e nel report: pianificato a oggi, prodotto, ore prenotate, efficienza e rispetto dei tempi, calcolati dalle ore pianificate e dalle ore prenotate.
- Panoramica con quattro indicatori, ciambella delle deviazioni, avanzamento per sezione, ore per settimana e pannello **Lavoro prodotto**.
- Import degli export di pianificazione dall'interfaccia, con anteprima e conferma, per sei famiglie di dati e con mappatura delle colonne per cantiere.
- Assistente dati in sola lettura, con citazioni dei record.
- Impostazioni di valuta, decimali e separatori per gli importi. Gli owner possono impostare anche il fuso e l'inizio del giorno operativo del cantiere.
- Tabelle ordinabili, filtri per colonna opzionali e card su telefono.
- Navigazione mobile con barra in basso.
- Navigazione desktop raggruppata in **Operazioni**, **Cantiere** e **Gestione**.
- Attività e diario consultabili offline. Le modifiche alle attività e i nuovi contributi del diario restano in coda fino alla sincronizzazione. Correzioni e storico del diario richiedono la connessione.
- Panoramica, bacheca, elenco con filtri, esportazione CSV, stampa del diario.
- Interfaccia italiano/inglese e layout responsive.

## Disponibile solo via API (non nell'interfaccia)

- Gestione dei membri del cantiere.
- Import degli snapshot tramite endpoint dedicati (oltre all'import di pianificazione dall'interfaccia): WBS, presenze, avanzamento e deviazioni.
- Creazione ed eliminazione dei tipi di avanzamento e dei loro pesi.
- **Impatti economici**: consultazione e chiusura con esito sono disponibili anche dall'interfaccia; creazione e aggiornamento degli importi restano via API.
- **Allegati al cantiere** e **eliminazione degli allegati**: il caricamento al cantiere e la rimozione restano via API.

## Non disponibile

- Eliminazione dei cantieri e modifica di nome, date o ubicazione.
- Modifica o eliminazione di attività ed eliminazione delle voci di diario.
- Modifica o eliminazione dei dati importati: avanzamento, deviazioni e presenze restano in sola lettura, salvo le ore pianificate delle voci di avanzamento.
- Eliminazione di ordini di acquisto, colli, spedizioni e ricezioni.
- Criteri di accettazione, descrizioni lunghe, checklist.
- Firme nell'interfaccia.
- Notifiche, calendario, pianificazione e mappe.
- Funzionamento offline delle viste dei moduli core (Deviazioni, Avanzamento, Prenotazioni ore, Impatti economici, Attrezzature, Idoneità, HSE, Logistica): richiedono la connessione.
- Connettori verso ERP, Primavera P6 o altri sistemi.
- Report PDF generati dal server.

## Limiti da conoscere

- L'evidenza di completamento è una **nota testuale**, non un allegato.
- Esecutore e verificatore sono inseriti come **nomi liberi**, non collegati agli account.
- Le date dei cantieri sono descrittive: non impediscono inserimenti fuori intervallo.
- Ogni voce di diario conserva il fuso orario e l'ora di taglio del cantiere registrati alla sua creazione.
- La stampa usa il browser: l'aspetto dipende dal browser e dai margini scelti.
- La lingua traduce l'interfaccia, non i contenuti inseriti.
- Gli allegati nell'interfaccia e via API sono limitati a **15 MiB** e ai soli formati immagine e PDF.
- L'import di pianificazione non cancella le righe assenti dal file e non si annulla dall'interfaccia.
- La mappatura delle colonne è per cantiere e famiglia: non si eredita tra cantieri e non aggiunge campi al modello.
- La valuta nelle impostazioni cambia simbolo e formato, non converte gli importi.
- L'anteprima di import vale 15 minuti: oltre, va ripetuta. Cambiare file o mappatura la invalida subito.
- L'assistente dati legge i dati del cantiere selezionato e non scrive nulla; richiede la connessione.
- Il collegamento tra avanzamento e WBS avviene solo con una corrispondenza univoca di area PLC e sezione: senza corrispondenza la voce resta scollegata.
- Gli stati delle deviazioni arrivano dal sistema di origine; uno stato non riconosciuto resta vuoto invece di essere interpretato.
- L'eliminazione di attrezzature, certificazioni ed eventi HSE è **logica**: la riga sparisce dalle viste, dai contatori e dai dettagli, ma resta nel registro di audit con autore e data, leggibile dal pannello **Ultime modifiche** delle tre viste e via API da owner e verificatori. Le certificazioni restano riservate a owner, editor e verificatori: il ruolo `viewer` non le consulta. Le persone coinvolte negli eventi HSE sono **solo un numero**: il registro non contiene nomi né dati sanitari e non è collegato alla scheda del dipendente.

:::caution[Dati]
La versione attuale è una demo operativa con dati di prova. Non inserire informazioni riservate, credenziali o dati contrattuali.
:::

## Come viene aggiornata questa documentazione

Le pagine vivono nel repository, in `docs-site/`, e vengono pubblicate automaticamente a ogni modifica su `main`. Se una funzione cambia, cambia la pagina che la descrive. Le pagine tradotte in inglese sono mantenute allineate alla versione italiana.
