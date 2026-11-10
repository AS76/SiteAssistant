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
| Caricare allegati su attività e diario | Sì | Sì | No | No |
| Eliminare un allegato — solo API | Sì | Sì | No | No |
| Creare impatti economici — solo API | Sì | Sì | Sì | No |
| Far avanzare o chiudere un impatto economico | Sì | No | Sì | No |

\* Solo se designato verificatore dell'attività, e mai sul proprio lavoro. L'owner può verificare anche attività di cui non è il verificatore designato, ma non può verificare ciò che ha eseguito lui stesso.

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

L'elenco e la modifica dei membri si fanno via API (`GET`/`POST /api/sites/{id}/members`) e sono riservati agli **owner**. In questa versione l'interfaccia **non** ha una schermata per i membri. Un owner non può rimuovere o declassare se stesso.

## Identità e sicurezza

Le password sono salvate con `scrypt`; le sessioni sono descritte in [Accesso e account](../../guida/accesso/). Non esiste recupero autonomo della password oltre al flusso "Password dimenticata" descritto nella stessa pagina.
