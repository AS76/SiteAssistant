---
title: Funzioni comuni
description: Navigazione, selezione del cantiere, lingua, filtri ed esportazioni disponibili in tutte le viste.
---

## Struttura dell'interfaccia

L'intestazione contiene, da sinistra a destra:

- il **selettore del cantiere**, che elenca solo i cantieri in cui hai un ruolo attivo;
- la **navigazione** tra le viste: **Panoramica**, **Cantieri**, **Attività**, **Diario**;
- il **selettore di lingua** (IT / EN);
- il nome dell'utente e il pulsante **Esci**.

La vista attiva è indicata nella navigazione ed è raggiungibile anche da URL con `#overview`, `#sites`, `#tasks`, `#diary`.

## Panoramica

Mostra il colpo d'occhio sul cantiere selezionato:

- attività aperte ordinate per urgenza e scadenza;
- avanzamento delle verifiche: chiuse sul totale, con conteggio di bloccate e in attesa di verifica;
- ultima voce di diario del giorno operativo corrente.

## Attività: board ed elenco

La vista **Attività** ha due rappresentazioni:

- **Bacheca**: colonne per stato (`todo`, `in_progress`, `to_verify`, `closed`, `blocked`);
- **Elenco**: righe con priorità, scadenza e persone coinvolte.

I filtri disponibili sono testo libero, stato, persona e priorità. Il filtro per persona elenca gli **esecutori** presenti nelle attività caricate, non i verificatori. Su schermi stretti la bacheca diventa un carosello orizzontale con aggancio alle colonne.

## Esportazioni e stampa

- **CSV** sulle attività attualmente caricate e filtrate, non sull'intero database.
- **Stampa** del diario tramite la finestra di stampa del browser: non esiste un PDF generato dal server.

## Lingua

Il selettore IT/EN traduce immediatamente le etichette dell'interfaccia. I contenuti inseriti dagli utenti — titoli, note, motivazioni, voci di diario — restano nella lingua in cui sono stati scritti.

La lingua scelta e il cantiere selezionato restano in memoria fino al ricaricamento della pagina.

## Accessibilità e dispositivi

L'interfaccia è responsive e navigabile da tastiera. I moduli di inserimento sono finestre modali con gestione del focus; gli errori di validazione sono annunciati nell'area di messaggio del modulo.
