---
title: Accesso e sessioni
description: Come si entra in SiteAssistant, quanto dura una sessione e come si gestiscono i tentativi falliti.
---

SiteAssistant non ha una pagina di registrazione autonoma: gli account vengono creati da un amministratore con la CLI `create-user` (vedi [Utenti e ruoli](../../amministrazione/utenti-e-ruoli/)).

## Entrare

1. Apri l'indirizzo dell'applicazione nel browser, da desktop o da smartphone.
2. Se non esiste una sessione attiva, compare il modulo di **accesso**.
3. Inserisci **email** e **password**, poi premi **Accedi**.
4. Dopo l'accesso vedi solo i cantieri in cui sei membro: il menu in alto permette di scegliere il contesto di lavoro.

L'email non distingue maiuscole e minuscole: `Mario.Rossi@example.com` e `mario.rossi@example.com` sono lo stesso account.

## Cosa succede quando l'accesso fallisce

| Risposta | Significato | Cosa fare |
| :-- | :-- | :-- |
| **400** | Email o password mancanti o non valide come formato | Ricontrolla i campi |
| **401** `INVALID_CREDENTIALS` | Credenziali errate, account inesistente o disabilitato | Riprova; se persiste, chiedi all'amministratore |
| **429** `RATE_LIMITED` | Troppi tentativi falliti | Attendi il tempo indicato in `Retry-After` |

Il messaggio di errore non rivela se a essere sbagliata sia l'email o la password.

## Limite sui tentativi

Dopo **10 tentativi** nella stessa finestra di **15 minuti**, per la stessa combinazione di indirizzo IP ed email, l'accesso viene bloccato con risposta **429** e header `Retry-After` in secondi. Il limite è per coppia IP + email: un utente bloccato non blocca gli altri.

## Durata e sicurezza della sessione

- Il server rilascia il cookie **`sa_session`**, valido **7 giorni**.
- Il cookie è `HttpOnly`, `SameSite=Lax` e `Secure` quando la richiesta arriva su HTTPS.
- Sul server non è salvato il token in chiaro, ma solo il suo hash SHA-256 nella tabella `sessions`.
- Ogni operazione registra come attore l'utente autenticato, non un nome digitato a mano.

## Uscire

Il pulsante **Esci** revoca la sessione sul server, invalida il cookie e scarica i dati caricati nella pagina. Chiudere il browser senza uscire non revoca la sessione: questa resta valida fino alla scadenza o al logout.

:::note[Sessione scaduta]
Se il cookie è scaduto o revocato, l'applicazione riporta al modulo di accesso e la navigazione precedente non è recuperabile.
:::
