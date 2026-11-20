#!/bin/sh
# Content scan: secret e dati personali nei file tracciati.
#
# Sostituisce la vecchia blacklist terminologica: quella bloccava un nome, questo cerca ciò che
# non deve stare in un repository pubblico — chiavi, token, codici fiscali, IBAN, file di dati.
# Dipendenze: solo git e grep.
#
# Uso:  sh scripts/content-scan.sh            (tutti i file tracciati)
#       sh scripts/content-scan.sh --staged   (solo ciò che è in stage, per il pre-commit)
set -eu

list_files() {
  if [ "${1:-}" = "--staged" ]; then
    git diff --cached --name-only --diff-filter=ACMR
  else
    git ls-files
  fi
}

files=$(list_files "${1:-}")
[ -z "$files" ] && { echo "Content scan: nessun file da controllare."; exit 0; }

fail=0
report() { echo "CONTENT SCAN: $1" >&2; fail=1; }

# 1. Chiavi private e token con prefissi riconoscibili.
patterns='-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}'
for f in $files; do
  case "$f" in *.png|*.jpg|*.jpeg|*.gif|*.webp|*.pdf|*.ico|*.woff*) continue;; esac
  if grep -nEI "$patterns" "$f" >/dev/null 2>&1; then report "possibile segreto in $f"; fi
done

# 2. File di dati: nel repository non entrano.
for f in $files; do
  case "$f" in
    *.xlsx|*.xls|*.csv|*.dbf|*.parquet|*.sql.gz|*.dump) report "file di dati tracciato: $f";;
  esac
done

# 3. Dati personali italiani: codice fiscale e IBAN.
for f in $files; do
  case "$f" in *.png|*.jpg|*.jpeg|*.gif|*.webp|*.pdf|*.ico|*.woff*) continue;; esac
  if grep -nEI '\b[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]\b' "$f" >/dev/null 2>&1; then
    report "possibile codice fiscale in $f"
  fi
  if grep -nEI '\bIT[0-9]{2}[A-Z][0-9]{10}[0-9A-Z]{12}\b' "$f" >/dev/null 2>&1; then
    report "possibile IBAN in $f"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "Content scan: bloccato. Togli il contenuto segnalato (non solo dal messaggio di commit)." >&2
  exit 1
fi
echo "Content scan: pulito ($(echo "$files" | wc -l) file)."
