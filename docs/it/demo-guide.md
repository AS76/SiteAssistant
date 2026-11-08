# SiteAssistant — Guida Utente della Demo

Questa guida illustra passo dopo passo l'utilizzo della versione dimostrativa di SiteAssistant.

> **Avvertenza:** La demo fa uso esclusivo di **dati sintetici e fittizi**. Non inserire informazioni personali reali, codici riservati, credenziali o dettagli contrattuali. L'istanza demo è accessibile pubblicamente con autenticazione Basic di perimetro.

---

## 1. Accesso e Configurazione Iniziale

1. Aprire l'interfaccia nel browser web (desktop o mobile).
2. **Selezione Lingua:** In alto a destra è disponibile il selettore di lingua (**IT** / **EN**). La commutazione adatta istantaneamente tutte le etichette, mantenendo invariati i testi inseriti.
3. **Contesto Cantiere:** Il menu a tendina *Cantiere* permette di selezionare il cantiere attivo. Tutte le viste (Attività, Bacheca, Diario) mostreranno esclusivamente i dati del cantiere selezionato.

---

## 2. Creazione di un Nuovo Cantiere

Se si desidera creare un nuovo cantiere di test:
1. Fare clic sul pulsante **«Nuovo cantiere»** (o accedere alla sezione dedicata).
2. Compilare i campi richiesti:
   - **Codice:** identificativo univoco alfanumerico (es. `PRJ-SYNTH-01`). Il sistema rifiuterà codici duplicati.
   - **Nome:** nome descrittivo dell'impianto (es. *Impianto Smistamento Test Alpha*).
   - **Ubicazione:** comune o riferimento logistico (es. *Polo Logistico Esempio*).
   - **Data Inizio / Data Fine:** date previste di commessa in formato `YYYY-MM-DD`. La data di fine non può precedere la data di inizio.
3. Confermare con **«Salva cantiere»**. Il cantiere apparirà immediatamente nel menu dei cantieri attivi.

---

## 3. Creazione di un'Attività (Task)

Per registrare una nuova attività all'interno del cantiere selezionato:
1. Fare clic su **«Nuova attività»**.
2. Compilare il modulo:
   - **Titolo:** descrizione sintetica dell'attività da compiere (es. *Posa passerelle cavi Linea 3*).
   - **Area:** zona o livello di impianto (es. *Area Soppalco B2*).
   - **Impresa:** ditta affidataria (es. *ElettroInstallazioni SRL*).
   - **Esecutore:** nome del caposquadra o tecnico che eseguirà il lavoro (es. *M. Rossi*).
   - **Verificatore:** nome del tecnico/ispettore designato al controllo (es. *L. Bianchi*).
     > **Regola tassativa:** Esecutore e Verificatore **devono essere due persone diverse**. Se si inserisce lo stesso nominativo, il sistema bloccherà il salvataggio.
   - **Priorità:** selezionare tra `Normale`, `Alta`, `Urgente`.
   - **Scadenza:** data limite in formato `YYYY-MM-DD`.
3. Fare clic su **«Crea attività»**. Il task verrà inserito nello stato iniziale **Da fare** (`todo`).

---

## 4. Esecuzione delle Transizioni di Stato

Il ciclo di avanzamento e collaudo dell'attività segue regole rigorose:

```text
[todo] ──(Avvia)──> [in_progress] ──(Sottoponi a verifica)──> [to_verify] ──(Verifica e Chiudi)──> [closed]
  │                       │                                        │                                   │
  └──(Blocca)─────────────┴────────────(Blocca)────────────────────┘                                   │
                                                                                                       │
                                       [in_progress] <────────(Riapri con motivo)──────────────────────┘
```

### 4.1 Avvio dell'attività (`todo` $\rightarrow$ `in_progress`)
- Nella scheda del task fare clic su **«Avvia»**.
- Inserire il nome dell'attore che registra l'operazione.
- Lo stato passerà a **In corso** (`in_progress`).

### 4.2 Segnalazione di un Blocco (`blocked`)
- Da qualunque stato aperto (`todo`, `in_progress`, `to_verify`), fare clic su **«Blocca»**.
- È **obbligatorio** inserire una motivazione dettagliata (es. *Mancata fornitura staffe di supporto dal fornitore*).
- Il task risulterà evidenziato come Bloccato, conservando il motivo a registro storico.

### 4.3 Dichiarazione di completamento (`in_progress` $\rightarrow$ `to_verify`)
- Quando il montaggio o l'intervento è ultimato, fare clic su **«Dichiara completato»** (o *Sottoponi a verifica*).
- È **obbligatorio** compilare il campo **Nota di evidenza** (es. *Passerelle posate, verificata planarità e serraggio bulloni*).
- Il task passa a **In verifica** (`to_verify`).

### 4.4 Verifica formale e Chiusura (`to_verify` $\rightarrow$ `closed`)
- Solo il **Verificatore designato** indicato nella creazione del task può chiudere l'attività.
- Fare clic su **«Verifica e Chiudi»**.
- Inserire il nome dell'attore (che deve corrispondere al campo Verificatore) e una **Nota di verifica** (es. *Ispezione visiva superata, conformità al disegno esecutivo rev. B*).
- Se un altro operatore tenta la chiusura, il sistema rifiuterà l'operazione.
- Il task passa a **Chiuso** (`closed`).

### 4.5 Riapertura di un task chiuso (`closed` $\rightarrow$ `in_progress`)
- Se durante controlli successivi emergono non conformità, è possibile riaprire il task tramite **«Riapri attività»**.
- È **obbligatorio** fornire una motivazione di riapertura (es. *Rilevata interferenza con nuova linea pneumatica, necessaria modifica staffaggio*).

---

## 5. Compilazione del Diario Operativo di Cantiere (Diary)

Il diario consente di redigere il rapporto formale di turno:
1. Accedere alla scheda **«Diario»**.
2. Indicare i parametri di intestazione:
   - **Data operativa:** data del giorno lavorativo in formato `YYYY-MM-DD`.
   - **Turno:** scegliere tra **Giorno** (`day`) o **Notte** (`night`).
3. Compilare le quattro sezioni informative:
   - **Piano della giornata:** le attività che la squadra si prefiggeva di compiere.
   - **Lavoro svolto:** il consuntivo effettivo a fine turno.
   - **Impedimenti / Ritardi:** eventuali fermi impianto, condizioni meteo avverse o ritardi logistici.
   - **Prossimi passi:** istruzioni di passaggio consegne per il turno successivo.
4. Fare clic su **«Salva diario»**.
   > **Nota sull'unicità:** Esiste una sola registrazione per ciascuna combinazione di Cantiere + Data Operativa + Turno. Inserimenti successivi per la stessa terna verranno respinti dal sistema come duplicati.
5. **Stampa:** Il pulsante **«Stampa»** genera una versione impaginata e pulita adatta all'esportazione in PDF o stampa cartacea tramite il dialogo nativo del browser.
