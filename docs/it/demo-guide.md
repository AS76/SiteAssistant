# SiteAssistant — Guida Utente della Demo

Questa guida illustra passo dopo passo l'utilizzo della versione dimostrativa di SiteAssistant.

> **Avvertenza:** La demo fa uso esclusivo di **dati sintetici e fittizi**. Non inserire informazioni personali reali, codici riservati, credenziali o dettagli contrattuali. L'istanza demo è protetta al perimetro di rete (Basic Auth) e dispone di autenticazione applicativa con ruoli per cantiere.

---

## 1. Accesso e Autenticazione

L'applicazione integra un sistema di autenticazione locale basato su email e password personali:

1. Aprire l'interfaccia nel browser web (desktop o mobile).
2. Se non è presente una sessione attiva, l'applicazione presenta la schermata di **Accesso** (`login`):
   - Inserire l'**Email** e la **Password**.
   - Premere **«Accedi»**.
3. **Sessione su cookie sicuro:** A fronte di credenziali valide, il server rilascia un cookie di sessione protetto (`sa_session`, durata 7 giorni, HttpOnly, SameSite=Lax, Secure su canale HTTPS).
4. **Stati di errore all'accesso:**
   - **401 (Credenziali non valide):** Se email o password sono errate, il sistema segnala l'errore senza rivelare quale dei due campi sia scorretto.
   - **429 (Troppi tentativi / Rate limit):** Dopo 10 tentativi falliti nell'arco di 15 minuti (per IP e indirizzo email), l'accesso viene temporaneamente bloccato con indicazione del tempo di attesa (`Retry-After`).
   - **401 (Sessione scaduta o non valida):** Se il cookie è scaduto o revocato, la navigazione viene interrotta e si torna al modulo di accesso.
5. **Uscita (Logout):** Il pulsante **«Esci»** in alto revoca immediatamente la sessione sul server, invalida il cookie e pulisce i dati caricati in memoria locale.
6. **Selezione Lingua:** In alto a destra è disponibile il selettore di lingua (**IT** / **EN**). La commutazione adatta istantaneamente tutte le etichette dell'interfaccia, mantenendo invariati i testi inseriti.
7. **Selezione Cantiere:** Il menu a tendina *Cantiere* elenca esclusivamente i cantieri su cui l'utente possiede un'appartenenza attiva. Le viste (Panoramica, Attività, Bacheca, Diario) mostrano solo i dati del cantiere selezionato.

---

## 2. Ruoli per Cantiere e Permessi

I permessi all'interno di SiteAssistant non sono generici, ma definiti per singolo cantiere (`site_members`). Ciascun utente autenticato può ricoprire un ruolo differente in ciascun cantiere assegnato:

| Ruolo | Lettura viste | Creazione/Modifica Attività | Diario di cantiere | Sottomissione verifica | Verifica e Rifiuto (`to_verify`) | Gestione membri e Cantiere |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Owner** | Sì | Sì | Sì (scrittura) | Sì | Sì (se non sottomesso da sé) | Sì (assegna membri e crea cantieri) |
| **Editor** | Sì | Sì | Sì (scrittura) | Sì | No | No |
| **Verifier** | Sì | Sì | Sì (scrittura) | Sì | Sì (se non sottomesso da sé) | No |
| **Viewer** | Sì | No (solo lettura) | No (solo lettura) | No | No | No |

- Se un utente tenta un'operazione non consentita dal proprio ruolo sul cantiere selezionato (ad esempio un `viewer` che tenta di creare un'attività, o un `editor` che tenta di validare una verifica), il server risponde con errore **403 (Operazione non consentita / FORBIDDEN)**.

---

## 3. Creazione e Gestione Utenti (CLI `create-user`)

La creazione degli utenti e l'assegnazione iniziale dei ruoli è uno strumento operativo da riga di comando per l'amministratore di sistema (non un modulo pubblico dell'interfaccia web):

- **Strumento:** Script eseguibile Node.js `server/create-user.mjs` (oppure `npm run create-user`).
- **Parametri richiesti:**
  - `--email <indirizzo>`: email univoca (normalizzata in minuscolo).
  - `--name <nome>`: nome esteso dell'operatore.
- **Assegnazione cantiere (opzionale):**
  - `--site <codice_cantiere>` e `--role <ruolo>`: devono essere indicati congiuntamente. I ruoli ammessi sono `owner`, `editor`, `verifier`, `viewer`.
- **Politica password:**
  - Lunghezza minima obbligatoria: **12 caratteri**.
  - La password non viene mai passata come argomento della riga di comando (`argv`), per proteggerla dalla cronologia di shell e dai listati dei processi di sistema (`ps`). Viene richiesta in modo interattivo e oscurato via terminale TTY, oppure letta da standard input con `--password-stdin`.

**Esempio di comando amministrativo:**

```bash
# Inserimento interattivo con password oscurata a prompt:
npm run create-user -- --email supervisore@cantiere.invalid --name "Marco Rossi" --site PRJ-ALPHA-01 --role editor
# Il sistema richiederà: Password: [input oscurato]

# Oppure tramite pipe da stdin:
printf '%s' '********' | npm run create-user -- --email ispettore@cantiere.invalid --name "Laura Bianchi" --site PRJ-ALPHA-01 --role verifier --password-stdin
```

---

## 4. Creazione di un Nuovo Cantiere

La creazione di un nuovo cantiere richiede il ruolo **Owner** su almeno un cantiere esistente:
1. Fare clic sul pulsante **«Nuovo cantiere»**.
2. Compilare i campi richiesti:
   - **Codice:** identificativo univoco alfanumerico (es. `PRJ-SYNTH-01`). Il sistema rifiuterà codici duplicati.
   - **Nome:** nome descrittivo dell'impianto (es. *Impianto Smistamento Test Alpha*).
   - **Ubicazione:** comune o riferimento logistico (es. *Polo Logistico Esempio*).
   - **Data Inizio / Data Fine:** date previste di commessa in formato `YYYY-MM-DD`. La data di fine non può precedere la data di inizio.
3. Confermare con **«Salva cantiere»**. L'utente creatore riceve automaticamente il ruolo **Owner** sul nuovo cantiere creato.

---

## 5. Creazione di un'Attività (Task)

Per registrare una nuova attività all'interno del cantiere selezionato (ruoli **Owner**, **Editor** o **Verifier**):
1. Fare clic su **«Nuova attività»**.
2. Compilare il modulo:
   - **Titolo:** descrizione sintetica dell'attività da compiere (es. *Posa passerelle cavi Linea 3*).
   - **Area:** zona o livello di impianto (es. *Area Soppalco B2*).
   - **Impresa:** ditta affidataria (es. *ElettroInstallazioni SRL*).
   - **Esecutore:** nome o riferimento dell'esecutore materiale del lavoro.
   - **Verificatore:** nome del tecnico/ispettore designato al controllo.
     > **Regola tassativa di separazione:** Esecutore e Verificatore **devono essere due entità distinte**. Se coincidono, la richiesta viene respinta.
   - **Priorità:** selezionare tra `Normale`, `Alta`, `Urgente`.
   - **Scadenza:** data limite in formato `YYYY-MM-DD`.
3. Fare clic su **«Crea attività»**. Il task verrà inserito nello stato iniziale **Da fare** (`todo`).

---

## 6. Esecuzione delle Transizioni di Stato

Il ciclo di avanzamento e verifica segue una macchina a stati finiti con tracciamento rigoroso:

```text
[todo] ──(Avvia)──> [in_progress] ──(Sottoponi a verifica)──> [to_verify] ──(Verifica e Chiudi)──> [closed]
  │                       │                                        │                                   │
  └──(Blocca)─────────────┴────────────(Blocca)────────────────────┘                                   │
                                                                                                       │
                                       [in_progress] <────────(Riapri con motivo)──────────────────────┘
```

> **Regola cardine sull'identità dell'attore (`actor`):** L'identità di chi compie l'azione **non è più un campo libero compilato dal client**, ma viene estratta in modo vincolante e sicuro dalla sessione autenticata dell'utente. Non è possibile impersonare altri operatori.

### 6.1 Avvio dell'attività (`todo` $\rightarrow$ `in_progress`)
- Nella scheda del task fare clic su **«Avvia»**.
- L'attore registrato corrisponde al profilo dell'utente collegato.
- Lo stato passerà a **In corso** (`in_progress`).

### 6.2 Segnalazione di un Blocco (`blocked`)
- Da qualunque stato aperto (`todo`, `in_progress`, `to_verify`), fare clic su **«Blocca»**.
- È **obbligatorio** inserire una motivazione dettagliata (es. *Mancata fornitura staffe di supporto dal fornitore*).
- Il task risulterà evidenziato come Bloccato, memorizzando lo stato di provenienza per consentire il ripristino.

### 6.3 Dichiarazione di completamento (`in_progress` $\rightarrow$ `to_verify`)
- Quando le lavorazioni sono ultimate, fare clic su **«Dichiara completato»** (o *Sottoponi a verifica*).
- È **obbligatorio** compilare il campo **Nota di evidenza** (es. *Passerelle posate, verificata planarità e serraggio bulloni*).
- Il server memorizza l'identificativo univoco dell'utente che ha effettuato la sottomissione (`submitted_by_id`).
- Lo stato passa a **In verifica** (`to_verify`).

### 6.4 Verifica formale e Chiusura (`to_verify` $\rightarrow$ `closed`)
- **Regola chiave anti-autoapprovazione:** L'utente che esegue la verifica o il rifiuto **non può essere la stessa persona che ha dichiarato il completamento** (`submitted_by_id`). Se chi ha sottomesso il lavoro tenta di validarlo, il server rifiuta l'azione con errore **409 (INVALID_TRANSITION)**.
- L'operazione richiede un ruolo di **Verifier** o **Owner** sul cantiere.
- Fare clic su **«Verifica e Chiudi»**, inserendo la **Nota di collaudo** obbligatoria.
- Lo stato passa a **Chiuso** (`closed`).

### 6.5 Rifiuto della verifica (`to_verify` $\rightarrow$ `in_progress`)
- Se il collaudo rileva imperfezioni, il verificatore (diverso dal sottomittente) può rifiutare la verifica rimandando il task in lavorazione con nota esplicativa.

### 6.6 Riapertura di un task chiuso (`closed` $\rightarrow$ `in_progress`)
- In caso di contestazioni o necessità di ripresa dei lavori, gli utenti abilitati possono riaprire il task fornendo una motivazione obbligatoria.

---

## 7. Compilazione del Diario Operativo di Cantiere (Diary)

Il diario registra formalmente le attività e il passaggio consegne per turno (accessibile in scrittura a **Owner**, **Editor** e **Verifier**):
1. Accedere alla sezione **«Diario»**.
2. Indicare i parametri di riferimento:
   - **Data operativa:** data del giorno lavorativo in formato `YYYY-MM-DD` (se omessa via API, viene calcolata automaticamente in base alla regola dell'ora di taglio delle 06:00 locali).
   - **Turno:** scegliere tra **Giorno** (`day`) o **Notte** (`night`).
3. Compilare le quattro sezioni operative:
   - **Piano della giornata:** le attività programmate per il turno.
   - **Lavoro svolto:** il consuntivo effettivo a fine turno.
   - **Impedimenti / Ritardi:** eventuali fermi impianto, imprevisti o carenze materiali.
   - **Prossimi passi:** istruzioni di consegna per il turno successivo.
4. Fare clic su **«Salva diario»**.
   > **Vincolo di unicità:** Esiste un solo record per cantiere, data operativa e turno `(site_id, operational_date, shift)`. Inserimenti duplicati vengono respinti.
5. **Stampa:** Il pulsante **«Stampa»** genera una versione ottimizzata per la stampa cartacea o l'esportazione PDF pulita da browser.
