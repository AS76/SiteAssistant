# SiteAssistant — Presentazione di Prodotto

## 1. Cos'è SiteAssistant

SiteAssistant è una web application operativa progettata per il **Site Manager** e l'**Installation Manager** impegnati su cantieri di intralogistica, automazione industriale, robotica e sistemi MHE (*Material Handling Equipment*).

SiteAssistant si colloca come **anello di congiunzione operativo** tra la pianificazione di alto livello (gestita tipicamente tramite ERP, tool di scheduling come Primavera P6, o fogli di calcolo di commessa) e la gestione quotidiana in campo. Non intende sostituire un ERP aziendale né un sistema contabile: la sua missione è fornire uno strumento essenziale, rapido e utilizzabile direttamente da smartphone o tablet in cantiere per:
- governare l'avanzamento reale delle attività;
- tracciare blocchi operativi ed evidenze di verifica;
- redigere il diario di cantiere giornaliero per turno di lavoro.

---

## 2. A chi serve

I principali destinatari del sistema sono:
- **Site Manager / Installation Manager:** responsabili del coordinamento quotidiano delle imprese e del rispetto delle scadenze di montaggio e messa in servizio.
- **Capisquadra e Supervisori di montaggio (Lead / Executor):** figure che eseguono i compiti e richiedono sblocco immediato a fronte di impedimenti tecnici o interferenze.
- **Verificatori e Collaudatori (Verifier / Quality Inspector):** tecnici responsabili di accertare formalmente la conformità delle attività prima della chiusura.

*Non-utenti dell'attuale perimetro:* ufficio acquisti, controllo di gestione (controlling), cliente finale.

---

## 3. Cosa fa oggi (Funzionalità implementate nella demo)

L'attuale versione dimostrativa (frontend statico collegato a REST API e database PostgreSQL / SQLite) implementa quattro moduli fondamentali:

### 3.1 Gestione Cantieri (Sites)
- Creazione e censimento cantieri con codice univoco, nome descrittivo, ubicazione geografica e date di inizio/fine previste.
- Selezione del cantiere attivo come contesto operativo di lavoro.

### 3.2 Gestione Attività (Tasks)
- Creazione di attività assegnate a uno specifico cantiere, caratterizzate da: titolo, area di impianto, impresa affidataria, esecutore (*executor*), verificatore designato (*verifier*), livello di priorità (`normal`, `high`, `urgent`) e data di scadenza (*due date*).
- **Separazione dei ruoli:** il sistema impone che l'esecutore e il verificatore siano persone distinte già in fase di creazione.
- Visualizzazione a lista e a bacheca (*board*); su mobile la bacheca scorre orizzontalmente a snap tra le colonne. Filtri per stato e cantiere.
- Esportazione dei dati delle attività caricate in formato CSV (con protezione integrata contro l'iniezione di formule).

### 3.3 Macchina a stati delle attività e verifiche
Il ciclo di vita delle attività è governato da una macchina a stati finiti con transizioni vincolate e storico immutabile degli eventi (`task_events`):
- `todo` (Da fare) $\rightarrow$ avviabile a `in_progress` oppure bloccabile a `blocked` (con motivazione obbligatoria).
- `in_progress` (In corso) $\rightarrow$ sottomettibile a `to_verify` (richiede nota descrittiva dell'esecutore) oppure bloccabile a `blocked` (con motivazione obbligatoria).
- `to_verify` (In verifica) $\rightarrow$ chiudibile a `closed` (richiede nota di collaudo e **può essere eseguita solo dal verificatore designato**) oppure bloccabile a `blocked`.
- `closed` (Chiuso) $\rightarrow$ riapribile a `in_progress` (richiede motivazione obbligatoria dell'attore).
- `blocked` (Bloccato) $\rightarrow$ registra lo stato di blocco e il motivo tecnico/organizzativo.

### 3.4 Diario Operativo di Cantiere (Diary)
- Compilazione del giornale dei lavori strutturato per **cantiere**, **giorno operativo** (*operational date*, formato `YYYY-MM-DD`) e **turno** (`day` / `night`).
- Articolazione in quattro sezioni operative:
  1. *Piano della giornata (Plan)*: attività pianificate per il turno.
  2. *Lavoro effettivamente svolto (Actual)*: consuntivo operativo a fine turno.
  3. *Impedimenti e ritardi (Impediments)*: ostacoli, interferenze, mancanze materiali.
  4. *Prossimi passi (Next Step)*: consegne per il turno o il giorno successivo.
- **Unicità del turno:** la chiave composita `(site_id, operational_date, shift)` garantisce l'assenza di sovrascritture o duplicazioni per lo stesso turno.
- Funzione di formattazione e stampa del diario da browser.

---

## 4. Stato Attuale e Limiti della Demo

La versione attualmente attiva è un prototipo funzionale pubblicato a fini di convalida dei processi operativi. Presenta le seguenti caratteristiche e limitazioni:

- **Dati sintetici:** l'istanza contiene esclusivamente dati fittizi e di test.
- **Assenza di autenticazione applicativa:** l'accesso alla demo pubblica è protetto al perimetro (HTTP Basic Auth). All'interno dell'app non esiste ancora un login per utente: i campi persona (`executor`, `verifier`, autore della transizione) sono stringhe rivendicate dall'operatore.
- **Evidenze testuali:** le verifiche e i blocchi supportano note testuali; il caricamento file (foto, allegati PDF, bolle) non è ancora abilitato nella demo.
- **Supporto bilingue:** interfaccia utente commutabile tra Italiano e Inglese; i contenuti liberi inseriti dall'utente restano nella lingua di digitazione.

---

## 5. Roadmap e Funzionalità Pianificate

Le evoluzioni architetturali e funzionali già formalizzate nelle specifiche di progetto includono:
1. **Autenticazione e Controllo Accessi:** introduzione di identità utente locali (email + password scrypt) o Google OAuth, con ruoli definiti a livello di cantiere (`owner`, `editor`, `verifier`, `viewer`).
2. **Regola del giorno operativo a cutoff configurabile:** calcolo automatico della data operativa del turno con taglio orario (default 06:00 locali) e gestione dei turni notturni a cavallo di mezzanotte.
3. **Archiviazione Allegati (S3):** modulo per caricamento immagini e documenti su bucket object storage dedicato (compatibile S3) con verifica crittografica (checksum SHA-256) e manifest di integrità.
4. **Modulo di Ingestione Dati (Import):** pipeline per l'acquisizione di pianificazioni, presenze ed elenchi deviazioni provenienti da sistemi terzi, preservando la separazione tra dati ufficiali esterni e note operative interne.
