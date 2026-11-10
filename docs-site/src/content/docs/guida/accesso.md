---
title: Accesso e account
description: Come entri in SiteAssistant, come richiedi un account e come gestisci la password.
---

Entri in SiteAssistant con la tua **email** e la tua **password**. Non esiste una registrazione pubblica: gli account si creano in due modi, entrambi pensati per chi lavora in cantiere.

## Entrare

1. Apri l'indirizzo dell'applicazione nel browser, da desktop o da smartphone.
2. Se non c'è una sessione attiva, compare il modulo **Accedi**.
3. Inserisci **email** e **password**, poi premi **Accedi**.
4. Dopo l'accesso vedi solo i cantieri di cui sei membro e puoi scegliere il contesto di lavoro dal menu in alto.

L'email non distingue maiuscole e minuscole: `Mario.Rossi@example.com` e `mario.rossi@example.com` sono lo stesso account.

## Se non hai ancora un account

Dal modulo di accesso puoi premere **Richiedi accesso**:

1. Inserisci la tua email.
2. La richiesta arriva a chi amministra l'applicazione, che può **approvarla** o **rifiutarla**.
3. Se viene approvata, ricevi via email una **password temporanea**.
4. Al primo accesso l'applicazione ti invita a **cambiare la password**.

La richiesta non crea l'account da sola: serve l'approvazione di un amministratore. Il link di revisione che riceve l'amministratore scade dopo **72 ore** e vale una sola volta: se è scaduto, la richiesta va ripetuta.

## Password dimenticata o da cambiare

- **Password dimenticata:** dal modulo di accesso premi **Password dimenticata** e inserisci la tua email. Se l'account esiste, ricevi una nuova password temporanea via email.
- **Cambiare la password:** se stai usando una password temporanea, compare un avviso con il pulsante **Cambia la password**. Serve la password attuale e una nuova password, diversa e di almeno **12 caratteri**. Le altre sessioni vengono chiuse.

Se il servizio email non è attivo, queste operazioni non sono disponibili: l'applicazione lo segnala con un messaggio e ti invita a riprovare.

Richieste di accesso, reset e cambio password sono limitati: dopo **10 tentativi** nella stessa finestra di **15 minuti** l'operazione viene sospesa per qualche minuto.

## Quando l'accesso non riesce

Il messaggio di errore non rivela mai se a essere sbagliata è l'email o la password. Dopo **10 tentativi** falliti nella stessa finestra di **15 minuti** (per la stessa email e lo stesso indirizzo di rete), l'accesso viene sospeso per un po': attendi qualche minuto e riprova.

## Quanto dura la sessione

- La sessione dura **7 giorni** e viene ricordata dal browser con un cookie sicuro.
- Il pulsante **Esci** chiude subito la sessione sul server.
- Chiudere il browser senza uscire **non** chiude la sessione: resta valida fino alla scadenza o al prossimo logout.

:::note[Sessione scaduta]
Se la sessione scade o viene revocata, l'applicazione ti riporta al modulo di accesso.
:::
