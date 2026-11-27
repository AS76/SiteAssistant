---
title: Inventario dei trattamenti
description: I trattamenti documentati dal progetto SiteAssistant per l'installazione demo, con finalità, dati, retention e misure. Include il registro accessi alla demo.
---

> **Ambito.** Questa pagina elenca i trattamenti che il progetto SiteAssistant documenta per la propria installazione dimostrativa. **Non è** il registro dei trattamenti dell'organizzazione che installa il software: quel registro lo redige il titolare, che decide finalità, base giuridica e conservazione dei propri dati. Vedi [Privacy e responsabilità](../privacy-responsabilita/) e la [checklist di adozione](../privacy-checklist/).

## Trattamenti documentati

| Trattamento | Finalità | Dati personali | Base giuridica | Retention | Misure principali |
| --- | --- | --- | --- | --- | --- |
| Registro accessi alla demo | Sapere chi entra nella demo, quando, quanto spesso e con quali fallimenti; sicurezza del servizio | Identificativo utente, data e ora, indirizzo IP troncato, user-agent, classe di motivo del fallimento | Dichiarata dal titolare dell'installazione demo come finalità di sicurezza del servizio (vedi sotto) | 180 giorni, senza cancellazione automatica | IP troncato all'ingest; nessuna password né token; nessun tracker nel browser |

## Registro accessi alla demo

### Perché esiste

Per sapere chi entra nella demo, quando e quanto spesso, e per distinguere un uso normale da un accesso abusivo, senza introdurre una piattaforma di analisi esterna. I dati restano nel database dell'applicazione e non alimentano tracker nel browser.

### Eventi registrati

- `login.success` — accesso riuscito, con password o passkey.
- `login.failure` — accesso fallito, con la **classe di motivo** (per esempio credenziali errate o blocco per troppi tentativi). La password digitata non viene mai registrata.
- `logout` — uscita esplicita.
- `session.expired` — sessione scaduta.
- `activation.used` — attivazione di un invito completata.
- `invitation.sent` — invito inviato.
- `invitation.used` — invito utilizzato.

Per ogni evento il registro conserva l'utente quando esiste, la data e l'ora, l'indirizzo IP troncato, lo user-agent (fino a 1000 caratteri) e un campo tecnico di dettaglio con il metodo di accesso o la classe di motivo. **Nessuna password, nessun token di invito e nessun segreto viene scritto nel registro.**

### Misura sull'indirizzo IP

L'indirizzo viene troncato al momento della registrazione, non conservato per intero e poi ridotto:

- **IPv4**: si conservano i primi tre blocchi, per esempio `203.0.113.0` (cioè /24).
- **IPv6**: si conserva il prefisso /48.

La troncatura è una riduzione, non un'anonimizzazione. Un hash non salato dell'indirizzo sarebbe reversibile con tentativi sullo spazio IPv4 e non renderebbe l'indirizzo non identificabile: per questo il progetto dichiara il troncamento e non usa hash.

### Retention e cancellazione

- **180 giorni** è il periodo di conservazione dichiarato per il registro.
- **Nessuna cancellazione automatica sui dati reali** senza l'approvazione del Product Owner: l'eventuale cancellazione resta un'operazione manuale e approvata.
- Nella versione documentata il software non esegue un purge automatico del registro.

### Base giuridica

La finalità dichiarata è la sicurezza del servizio e la misura dell'uso della demo. La qualificazione giuridica — per esempio l'interesse legittimo del titolare — va confermata dal titolare dell'installazione nella propria valutazione privacy: il software non attribuisce basi giuridiche automatiche e questa pagina non è consulenza legale.

### Dove sono i dati e come si consultano

Il registro è la tabella `auth_events` del database dell'applicazione (SQLite o PostgreSQL). Il report aggregato si ottiene da riga di comando, in sola lettura:

```bash
npm run stats -- --from 2026-11-01 --to 2026-11-30
```

Il report contiene il totale degli accessi riusciti, gli utenti distinti, gli accessi per giorno, l'ultimo accesso per utente e il numero di fallimenti.

### Riferimenti tecnici

- Migrazione `052_auth_activity` per SQLite e PostgreSQL: colonna `sessions.expiry_logged_at` e indice sugli eventi di login nell'`auth_events`.
- `server/auth-events.mjs`: registrazione degli eventi e troncamento dell'indirizzo IP.
- `server/stats.mjs`: report aggregato in sola lettura.
- Commit `5b2727d` (PR #49), che ha introdotto il registro.
- Card di lavoro: `165ca0b9` (questa voce dell'inventario) e `83653dc9` (registro accessi e report CLI).

Il percorso con cui una persona entra nella demo è descritto in [Accesso e account](../../guida/accesso/).

### Stato e data

Voce documentata il **26 novembre 2026** sulla versione in `main` (commit `1601a2d`). Le voci successive dell'inventario si aggiungono con la stessa struttura: finalità, dati, base giuridica, retention, misure e riferimenti verificabili.
