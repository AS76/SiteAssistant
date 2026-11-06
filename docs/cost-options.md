# Demo multiutente — valutazione economica

Stato: Railway scelto come piattaforma per la demo. Nessun servizio attivato; listini e condizioni non verificati in questa revisione. Le cifre condizionali sulle alternative non costituiscono un preventivo.

## Obiettivo

Una demo con URL HTTPS, accesso controllato, dati persistenti condivisi e dati iniziali sintetici. Limitare costi ricorrenti e lavoro di riscrittura, mantenendo un percorso verso il pilota operativo.

Vincolo aggiornato: la demo usa servizi separati; il riuso di server condivisi con altri carichi è escluso dal perimetro corrente.

## Alternative

La scelta corrente privilegia un unico fornitore per applicazione e database, con integrazione GitHub. La minimizzazione assoluta del canone resta subordinata alla semplicità di gestione dell'ambiente di prova.

L'archivio documentale si integra tramite S3 compatibile: valutare i costi di richieste, lettura/trasferimento, derivati e copie senza assumere duplicazione dei file su Railway. L'utilizzo interno complementare concentra lo sviluppo su import e viste, evitando di ricostruire i flussi ufficiali del sistema sorgente. I profili da implementare dipendono dai campioni effettivamente verificati.

| Opzione | Costo incrementale dell'hosting | Lavoro operativo e condizioni |
| --- | --- | --- |
| **Scelta: applicazione e PostgreSQL nello stesso progetto Railway** | Piano e consumi di app, database e storage da preventivare | Un'unica piattaforma per deploy, variabili, rete e servizi; backup e ripristino da verificare sul piano effettivo |
| Frontend statico e backend gestito integrato con PostgreSQL, login e storage | Potenzialmente 0 euro/mese entro quote e condizioni dei piani gratuiti da verificare | Valutare, per esempio, Cloudflare Pages con Supabase; definire policy di accesso, operazioni server e transazioni |
| App con backend Node.js dedicato e PostgreSQL gestito | Minimo e consumi da preventivare; gratuità non presunta | Valutare, per esempio, Railway con Neon; mantenere l'API applicativa e verificare quote, sospensione e recuperabilità |
| Nuovo hosting e database su piani a pagamento | Canone/minimo e consumi da preventivare | Budget più esplicito, capacità e gestione dipendenti dal piano; serve un confronto dei listini ufficiali prima di scegliere |

PostgreSQL non ha un canone di licenza. Il costo dipende da compute, memoria, disco, trasferimenti, backup, servizi accessori e manutenzione. Cambiare motore non garantisce un risparmio sul totale del progetto.

## Riduzione del costo di sviluppo

- Mantenere inizialmente HTML/CSS e moduli JavaScript dell'interfaccia esistente. Il passaggio a React non è un prerequisito per pubblicare una demo con backend.
- Eseguire una sola applicazione Node.js per frontend e API, con PostgreSQL separato nello stesso progetto Railway. Il frontend statico da solo non sostituisce logica server, autorizzazioni e transazioni.
- Riutilizzare le regole di dominio dopo aver separato identità simulate, autorizzazioni server e persistenza. Il selettore di persona della demo non diventa un meccanismo di autenticazione.
- Usare PostgreSQL fin dal primo backend condiviso, con migrazioni e test, confrontando il costo complessivo dei servizi che lo ospitano.
- Partire con accessi su invito e un metodo di autenticazione mantenuto da una libreria o un provider appropriato, da scegliere in base a condizioni e costi; nessuna autenticazione progettata artigianalmente.
- Conservare IT/EN, dati sintetici, backup e report essenziali. Aggiungere i moduli per incrementi; allegati, grandi import e offline hanno costi di sviluppo distinti.

## Decisione corrente

Procedere con il progetto tecnico per Railway, usando il suo servizio PostgreSQL nello stesso progetto dell'applicazione. Questo evita di introdurre un secondo fornitore per il database. Le alternative della tabella restano un confronto economico e non sono l'architettura selezionata.

Prima dell'attivazione verificare listino corrente, eventuale minimo del piano, uso compute/RAM, volumi, traffico e backup. Definire budget e notifiche di spesa dove disponibili. Per iniziare usare un solo ambiente cloud di prova con pochi utenti, limiti coerenti con la prova e dati sintetici. Gratuità, backup inclusi e assenza di consumo a riposo non sono presunti.

Prima della pubblicazione: verificare isolamento, login, accessi al database, storage persistente, esportabilità e un ripristino funzionante. Tutti i dati dimostrativi rimangono sintetici. Usare inizialmente il sottodominio del servizio se compatibile con il caso d'uso; un nuovo dominio ha un costo separato.

## Dati necessari per un preventivo

Numero di utenti simultanei, volume file, necessità di disponibilità continua, dominio, budget massimo e costo/tempo della manutenzione. Per i servizi esterni: listino attuale, piano ammesso per il tipo di utilizzo, quote e politiche di superamento soglia.
