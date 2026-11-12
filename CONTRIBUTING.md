# Come si lavora su SiteAssistant

Questo file descrive il modello di tracciamento, non lo stile del codice. Le regole valgono per chi
lavora al repository, umano o agente.

## Gli oggetti di GitHub, e a cosa servono qui

| Oggetto | A cosa serve | Dove si vede |
| --- | --- | --- |
| **Issue** (tipo `Bug`, `Feature`, `Task`) | unità di lavoro con un esito e qualcuno che la fa | Project *SiteAssistant*, kanban del vault |
| **Pull request** | modifica di codice in attesa di revisione | collegata all'issue con `Closes #N` |
| **Discussion** | proposta senza decisione | categoria *Ideas* |
| **Project** (`Status`: Todo / In progress / Done, campo `Priority`) | stato e ordine del lavoro | vista board e tabella |
| **Milestone** | fase con una fine | oggi solo `Pilot` |

Regola di scelta:

1. serve fare qualcosa, con un esito verificabile → **issue**, con il tipo nativo;
2. è una modifica di codice da rivedere prima del merge → **pull request** che chiude l'issue;
3. è un'idea su cui nessuno ha deciso → **Discussion**, non issue.

Un issue non è una proposta. Il backlog è uno stato del lavoro, non un tipo di oggetto: un issue in
`Todo` è backlog, lo stesso issue in `In progress` è lavoro in corso.

## Tipo, priorità, area: tre cose distinte

- **Tipo** (`Bug` / `Feature` / `Task`) è nativo di GitHub, si imposta dall'issue e si filtra nei
  Project. Non si duplica con un'etichetta.
- **Priorità** (`P1` alta, `P2` media, `P3` bassa) vive **solo** nel campo `Priority` del Project:
  una sola fonte, altrimenti le due copie divergono.
- **Area** è un'etichetta: `ingest`, `reporting`, `progress`, `ux`, `ops`, `auth`, `hr`, `logistics`,
  `planning`, `attachments`, più `security`, `debt`, `documentation`.

Le etichette non dicono lo stato: lo stato è `Status` nel Project.

## Quando una pull request

Obbligatoria per:

- migrazioni e cambi di schema;
- autorizzazione, sessioni, password, ruoli;
- cancellazioni o trasformazioni di dati;
- modifiche che un'altra sessione deve poter rivedere mentre io lavoro.

Diretta su `main` (con CI obbligatoria) per il resto: correzioni, testi, interfaccia, test.
`main` è protetto: i due check di CI sono richiesti, il bypass amministratore resta per le
emergenze documentate.

## Commit

Un commit per incremento accettato, messaggio in inglese, corpo con le decisioni e i numeri dei
test. Niente amend dopo la revisione: una correzione è un commit nuovo.

## Issue: come si scrivono

- titolo che dice il risultato, non l'attività («Il filtro area non nasconde lavoro legittimo»);
- corpo con problema, criterio di verifica e fuori perimetro;
- `Closes #N` nella pull request, non «rif. #N» quando l'intento è chiudere;
- alla chiusura: una riga con il commit e la prova.

## Documentazione

Il manuale utente è `docs-site/` ed è generato dal job `docs-sync`: non si modifica a mano se non
per una correzione urgente. La documentazione tecnica sta in `docs/`. Le decisioni di perimetro
stanno nel vault, non qui.
