---
title: Attività e verifiche
description: Stati, transizioni, evidenze e separazione tra esecutore e verificatore.
---

L'attività (*task*) è l'unità di lavoro eseguita in cantiere. Ogni attività appartiene a un cantiere, ha un esecutore e un verificatore distinti, e avanza solo attraverso transizioni consentite.

## Creare un'attività

Dal pulsante **Nuova attività**:

| Campo | Obbligatorio | Note |
| :-- | :-- | :-- |
| Titolo | Sì | Massimo 180 caratteri |
| Area | No | Massimo 100 caratteri |
| Impresa | No | Massimo 100 caratteri |
| Esecutore | Sì | Deve essere membro del cantiere con ruolo di scrittura |
| Verificatore | Sì | Deve essere membro con ruolo `owner` o `verifier` |
| Priorità | Sì | `normal`, `high`, `urgent` |
| Scadenza | No | Data, precompilata con oggi |

L'attività nasce in stato `todo`. **Esecutore e verificatore devono essere due persone diverse**: il server rifiuta l'assegnazione con `400 SEPARATE_PEOPLE_REQUIRED`.

## Stati

| Stato | Significato |
| :-- | :-- |
| `todo` | Pianificata, non ancora avviata |
| `in_progress` | In esecuzione |
| `to_verify` | Dichiarata completata, in attesa di verifica |
| `closed` | Verificata e chiusa |
| `blocked` | Ferma per un impedimento |

## Transizioni

| Da | A | Azione | Cosa serve |
| :-- | :-- | :-- | :-- |
| `todo` | `in_progress` | start | — |
| `todo` | `blocked` | block | Motivazione |
| `in_progress` | `to_verify` | submit | Nota di evidenza |
| `in_progress` | `blocked` | block | Motivazione |
| `to_verify` | `closed` | verify | Nota; solo verificatore designato o owner |
| `to_verify` | `in_progress` | reject | Nota; solo verificatore designato o owner |
| `to_verify` | `blocked` | block | Motivazione |
| `closed` | `in_progress` | reopen | Motivazione; solo verificatore designato o owner |

Regole che il server applica sempre:

- chi ha sottomesso il lavoro **non può** verificarlo né rifiutarlo (`409 INVALID_TRANSITION`);
- `blocked` non ha transizioni in uscita dall'interfaccia; via API è possibile la ripresa (`resume`) verso lo stato da cui era stato bloccato;
- ogni transizione registra attore, data/ora, stato di partenza e di arrivo, nota e motivazione nella cronologia dell'attività.

## Verifica e chiusura

La chiusura richiede due atti distinti: l'esecutore dichiara il completamento con una nota di evidenza, il verificatore conferma. La nota è obbligatoria in entrambi i passaggi. Se il verificatore rifiuta, l'attività torna `in_progress` e la nota di rifiuto resta nella cronologia.

L'evidenza è **testuale**: non sono previsti allegati, firme o foto.

## Bacheca ed elenco

La bacheca raggruppa le attività per stato, l'elenco le ordina per scadenza e priorità. Da entrambe si apre il dettaglio, che mostra i campi e la cronologia completa delle transizioni.

## Cosa non è disponibile

- Modificare un'attività dopo la creazione.
- Criteri di accettazione, descrizioni lunghe, checklist.
- Eliminare un'attività.
- Ripristino da file JSON.
