---
title: Utenti e ruoli
description: Ruoli per cantiere, creazione degli account e gestione delle appartenenze.
---

## Ruoli

Il ruolo è **per cantiere**, non globale. La stessa persona può essere `owner` su un cantiere e `viewer` su un altro. Senza appartenenza, il cantiere non esiste per quell'utente.

| Capacità | owner | editor | verifier | viewer |
| :-- | :-: | :-: | :-: | :-: |
| Vedere cantieri, attività e diario | Sì | Sì | Sì | Sì |
| Creare e avanzare attività | Sì | Sì | Sì | No |
| Scrivere il diario | Sì | Sì | Sì | No |
| Verificare o rifiutare | Sì* | No | Sì* | No |
| Riaprire un'attività chiusa | Sì* | No | Sì* | No |
| Gestire i membri del cantiere | Sì | No | No | No |
| Creare nuovi cantieri | Sì | No | No | No |

\* Solo se designato verificatore dell'attività, e mai sulla propria sottomissione. L'owner può verificare anche attività di cui non è verificatore designato, ma non può auto-verificarsi.

## Creare un account

Gli account si creano da riga di comando sul server, con la CLI inclusa nel progetto:

```sh
npm run create-user -- \
  --email mario.rossi@example.com \
  --name "Mario Rossi" \
  --password-stdin \
  --site CANTIERE01 \
  --role editor
```

Regole:

- la password si legge da TTY o da `--password-stdin`, **mai** come argomento (finirebbe nella history della shell);
- minimo **12 caratteri**;
- l'email viene normalizzata in minuscolo;
- `--site` e `--role` vanno indicati insieme; il codice cantiere deve esistere;
- i ruoli ammessi sono `owner`, `editor`, `verifier`, `viewer`;
- senza `--site` l'utente viene creato ma non associato ad alcun cantiere.

Per creare un utente senza assegnarlo subito:

```sh
npm run create-user -- --email mario.rossi@example.com --name "Mario Rossi" --password-stdin
```

## Gestire i membri

L'API espone la gestione delle appartenenze:

- `GET /api/sites/{id}/members` — elenco dei membri con ruolo (solo owner);
- `POST /api/sites/{id}/members` — imposta o rimuove un ruolo.

Corpo della richiesta:

```json
{ "user_id": "uuid-utente", "role": "verifier" }
```

Con `"role": null` l'utente viene rimosso dal cantiere. Un owner non può declassare se stesso: il server risponde `400 VALIDATION_ERROR`.

In questa versione l'interfaccia **non** ha una schermata per i membri: la gestione passa dall'API.

## Autenticazione e identità

Non esiste registrazione autonoma, recupero password o invio email dall'applicazione. Le password sono salvate con `scrypt`; le sessioni sono descritte in [Accesso e sessioni](../../guida/accesso/).
