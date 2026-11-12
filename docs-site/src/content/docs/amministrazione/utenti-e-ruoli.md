---
title: Utenti e ruoli
description: I ruoli per cantiere, come si creano gli account e come si gestiscono le appartenenze.
---

I permessi in SiteAssistant sono **per cantiere**, non globali: la stessa persona può essere `owner` su un cantiere e `viewer` su un altro. Senza appartenenza, il cantiere non esiste per quell'utente.

## I ruoli

| Capacità | owner | editor | verifier | viewer |
| :-- | :-: | :-: | :-: | :-: |
| Vedere cantieri, attività e diario | Sì | Sì | Sì | Sì |
| Creare e far avanzare attività | Sì | Sì | Sì | No |
| Scrivere il diario | Sì | Sì | Sì | No |
| Verificare o riaprire | Sì* | No | Sì* | No |
| Gestire i membri del cantiere | Sì | No | No | No |
| Creare nuovi cantieri | Sì | No | No | No |
| Importare un export di pianificazione dall'interfaccia | Sì | Sì | No | No |
| Importare snapshot tramite endpoint dedicati — solo API | Sì | No | No | No |
| Assegnare un tipo di avanzamento a una voce | Sì | No | No | No |
| Registrare il completamento degli step | Sì | Sì | No | No |
| Creare o eliminare tipi di avanzamento — solo API | Sì | No | No | No |
| Prenotare ore su presenze e avanzamento | Sì | Sì | No | No |
| Gestire il registro delle attrezzature | Sì | Sì | Sì | No |
| Consultare il registro HSE | Sì | Sì | Sì | No |
| Inserire, modificare o eliminare eventi HSE | Sì | Sì | No | No |
| Caricare allegati su attività e diario | Sì | Sì | No | No |
| Eliminare un allegato — solo API | Sì | Sì | No | No |
| Creare impatti economici — solo API | Sì | Sì | Sì | No |
| Far avanzare o chiudere un impatto economico | Sì | No | Sì | No |

\* Solo se designato verificatore dell'attività, e mai sul proprio lavoro. L'owner può verificare anche attività di cui non è il verificatore designato, ma non può verificare ciò che ha eseguito lui stesso. Un'attività assegnata con un nome libero, senza account collegato, può essere verificata solo da un owner.

## Come nasce un account

Un account può nascere in due modi:

1. **Richiesta autonoma.** Dal modulo di accesso, chiunque può premere **Richiedi accesso** e inserire la propria email; un owner la approva e l'utente riceve una password temporanea (vedi [Accesso e account](../../guida/accesso/)).
2. **Creazione dall'amministratore.** Chi gestisce il server può creare account e assegnarli subito a un cantiere con la CLI `create-user`:

```sh
npm run create-user -- \
  --email mario.rossi@example.com \
  --name "Mario Rossi" \
  --password-stdin \
  --site CANTIERE01 \
  --role editor
```

Regole principali:

- la password si legge da TTY o da `--password-stdin`, **mai** come argomento;
- minimo **12 caratteri**;
- l'email viene normalizzata in minuscolo;
- `--site` e `--role` vanno indicati insieme; il codice cantiere deve esistere;
- i ruoli ammessi sono `owner`, `editor`, `verifier`, `viewer`.

Le capacità marcate **solo API** si usano chiamando gli endpoint descritti in [API REST](../../riferimento/api/).

L'import dall'interfaccia è descritto in [Importare un export di pianificazione](../import-pianificazione/). I passaggi di stato degli impatti economici e la chiusura con esito sono disponibili anche nel dettaglio dell'impatto.

## Gestire i membri

L'elenco e la modifica dei **ruoli** si fanno via API (`GET`/`POST /api/sites/{id}/members`) e sono riservati agli **owner**. In questa versione l'interfaccia **non** ha una schermata dedicata ai ruoli. Un owner non può rimuovere o declassare se stesso.

Gli **accessi per modulo**, invece, si gestiscono dall'interfaccia: vedi la sezione seguente.

## Collegare le attività esistenti alle persone

A cosa serve: dare un account alle attività create quando il modulo accettava soltanto un nome scritto a mano.

Gli identificativi delle persone esistono dal passaggio all'autenticazione e i permessi li usavano già, ma il modulo di creazione non li compilava: le attività più vecchie portano solo i nomi. Il comando seguente li collega, senza toccare i nomi, la cronologia né chi ha inviato l'attività:

```sh
node server/recognise-responsibles.mjs --site <site_id>
node server/recognise-responsibles.mjs --site <site_id> --apply
```

`--site` vuole l'identificativo del cantiere, non il codice.

- **Prima la prova.** Senza `--apply` il comando non scrive nulla: stampa i conteggi `matched`, `unmatched` e `ambiguous` e l'elenco dei casi ambigui. I conteggi riguardano i singoli campi, esecutore e verificatore, quindi un'attività può contribuire due volte.
- **Solo corrispondenze esatte.** Un nome viene collegato quando, dopo aver ridotto spazi e maiuscole, corrisponde a un solo membro attivo con un ruolo adatto: per l'esecutore `owner`, `editor` o `verifier`, per il verificatore `owner` o `verifier`.
- **Ambigui e mancanti restano.** Due membri con lo stesso nome, o nessun membro con quel nome, lasciano l'attività com'è: `--apply` non indovina.
- **Ripetibile.** I campi già collegati vengono saltati, quindi rieseguire il comando non cambia nulla.
- **Database esistente.** Il comando apre il database già presente — `DATA_DIR` per SQLite, `DATABASE_URL` con `DB_DRIVER=pg` — e non esegue migrazioni.

## Accessi per modulo

A cosa serve: limitare ciò che un membro vede senza cambiargli il ruolo.

Nella vista **Cantieri**, sotto le schede dei cantieri, un owner trova la tabella **Accessi per modulo** per il cantiere selezionato: una riga per membro e una colonna per modulo. Togli la spunta per escludere quel membro dal modulo. La modifica viene salvata subito e vale solo per quel cantiere.

- **Nessuna configurazione, nessun cambiamento.** Finché non esiste una riga salvata, tutti i moduli restano consentiti: le restrizioni esistono solo dove un owner toglie la spunta.
- **Sempre consentiti.** **Panoramica** e **Cantieri** restano accessibili a ogni membro. Le caselle degli owner sono bloccate, così nessun owner può chiudersi fuori da un modulo. Anche **Oggi**, la prima schermata su telefono, non ha una casella: mostra solo i moduli consentiti.
- **Cosa cambia per il membro.** La voce del modulo sparisce dalla navigazione e un collegamento diretto mostra **Modulo non disponibile**. Le richieste via API rispondono `403 MODULE_FORBIDDEN`, sia in lettura sia in scrittura.
- **Dati aggregati.** La Panoramica legge deviazioni, avanzamento, ore, struttura progetto e impatti; il report legge deviazioni, avanzamento, ore e struttura progetto. Se escludi uno di questi moduli a un membro, la sua Panoramica non riesce a mostrare i dati aggregati.
- **Solo online.** La tabella non è modificabile offline: le caselle sono disabilitate finché l'applicazione non è connessa.

Gli accessi per modulo si sommano ai permessi del ruolo e non li allargano mai: un `viewer` a cui resta attivo un modulo continua a non poter scrivere.

## Identità e sicurezza

Le password sono salvate con `scrypt`; le sessioni sono descritte in [Accesso e account](../../guida/accesso/). Non esiste recupero autonomo della password oltre al flusso "Password dimenticata" descritto nella stessa pagina.
