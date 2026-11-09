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

## 3. Cosa fa oggi (Funzionalità implementate)

L'attuale versione dimostrativa (frontend statico collegato a REST API e database PostgreSQL / SQLite) implementa cinque aree funzionali fondamentali:

### 3.1 Autenticazione e Ruoli per Cantiere
- **Accesso applicativo:** autenticazione con credenziali locali (email e password con hashing scrypt), sessioni sicure gestite su cookie `sa_session` (durata 7 giorni, HttpOnly, SameSite=Lax, Secure su HTTPS) e protezione da tentativi ripetuti (rate limiting: max 10 tentativi ogni 15 minuti con gestione dell'errore HTTP 429).
- **Ruoli per cantiere (`site_members`):** autorizzazione profilata a livello di cantiere per ciascun utente:
  - `owner`: controllo completo di attività e diario, gestione membri e creazione cantieri;
  - `editor`: creazione e gestione attività, sottomissione a verifica e compilazione diario;
  - `verifier`: gestione attività, compilazione diario e approvazione/rifiuto verifiche;
  - `viewer`: consultazione in sola lettura.
- **Identità vincolante dell'attore:** l'attore di ogni transizione ed evento è ricavato in modo autoritativo dalla sessione utente attiva e non è falsificabile dal client.

### 3.2 Gestione Cantieri (Sites)
- Creazione e censimento cantieri con codice univoco, nome descrittivo, ubicazione geografica e date di inizio/fine previste (riservata agli utenti con ruolo `owner`).
- Selezione del cantiere attivo come contesto operativo di lavoro (limitato ai cantieri di cui l'utente è membro).

### 3.3 Gestione Attività (Tasks)
- Creazione di attività assegnate a uno specifico cantiere, caratterizzate da: titolo, area di impianto, impresa affidataria, esecutore (*executor*), verificatore designato (*verifier*), livello di priorità (`normal`, `high`, `urgent`) e data di scadenza (*due date*).
- **Separazione dei ruoli:** il sistema impone che l'esecutore e il verificatore siano persone distinte già in fase di creazione.
- Visualizzazione a lista e a bacheca (*board*); su mobile la bacheca scorre orizzontalmente a snap tra le colonne. Filtri per stato e cantiere.
- Esportazione dei dati delle attività caricate in formato CSV (con protezione integrata contro l'iniezione di formule).

### 3.4 Macchina a stati delle attività e verifiche
Il ciclo di vita delle attività è governato da una macchina a stati finiti con transizioni vincolate e storico immutabile degli eventi (`task_events`):
- `todo` (Da fare) $\rightarrow$ avviabile a `in_progress` oppure bloccabile a `blocked` (con motivazione obbligatoria).
- `in_progress` (In corso) $\rightarrow$ sottomettibile a `to_verify` (richiede nota descrittiva dell'esecutore) oppure bloccabile a `blocked` (con motivazione obbligatoria).
- `to_verify` (In verifica) $\rightarrow$ chiudibile a `closed` oppure rifiutabile con ritorno a `in_progress`.
- **Regola anti-autoapprovazione:** la verifica e il rifiuto possono essere eseguiti solo da un utente con ruolo `verifier` o `owner` che **non sia l'autore della sottomissione di completamento** (`submitted_by_id`).
- `closed` (Chiuso) $\rightarrow$ riapribile a `in_progress` (richiede motivazione obbligatoria dell'attore).
- `blocked` (Bloccato) $\rightarrow$ registra lo stato di blocco e il motivo tecnico/organizzativo, consentendo la ripresa dello stato precedente.

### 3.5 Diario Operativo di Cantiere (Diary)
- Compilazione del giornale dei lavori strutturato per **cantiere**, **giorno operativo** (*operational date*, formato `YYYY-MM-DD`) e **turno** (`day` / `night`).
- Calcolo automatico della data operativa del turno in base alla regola dell'ora di taglio (default 06:00 locali), con conservazione del fuso orario (`Europe/Rome`).
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
- **Protezione di perimetro e applicativa:** l'accesso alla demo pubblica è protetto al perimetro di rete (HTTP Basic Auth) e gestito a livello applicativo con credenziali e ruoli individuali.
- **Provisioning utenti via CLI:** la creazione degli account utente avviene tramite strumento da riga di comando dedicato (`server/create-user.mjs`), mentre la gestione delle appartenenze è gestita da API per gli utenti `owner`. Non è presente una schermata pubblica di auto-registrazione o recupero password.
- **Evidenze testuali:** le verifiche e i blocchi supportano note testuali strutturate; il caricamento file (foto, allegati PDF, bolle) non è ancora abilitato nella demo.
- **Supporto bilingue:** interfaccia utente commutabile tra Italiano e Inglese; i contenuti liberi inseriti dall'utente restano nella lingua di digitazione.

---

## 5. Roadmap e Funzionalità Pianificate

Le evoluzioni architetturali e funzionali già formalizzate nelle specifiche di progetto includono:
1. **Integrazione Google OAuth:** affiancamento del login federato alle credenziali locali già implementate.
2. **Interfaccia Web per Gestione Membri:** schermata visiva all'interno dell'app per consentire agli `owner` di invitare o modificare i ruoli degli utenti sui propri cantieri.
3. **Archiviazione Allegati (S3):** modulo per caricamento immagini e documenti su bucket object storage dedicato (compatibile S3) con verifica crittografica (checksum SHA-256) e manifest di integrità.
4. **Modulo di Ingestione Dati (Import):** pipeline per l'acquisizione di pianificazioni, presenze ed elenchi deviazioni provenienti da sistemi terzi, preservando la separazione tra dati ufficiali esterni e note operative interne.
