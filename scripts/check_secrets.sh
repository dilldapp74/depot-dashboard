#!/usr/bin/env bash
# Vor jedem Push ausführen. Bricht ab, wenn Depotdaten oder Geheimnisse im Repo landen würden.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
failed=0

# Persönliche Depotdaten (die Beispieldatei ist erlaubt)
private=$(git ls-files --cached | grep -E '(^|/)(holdings|alerts)\.json$' || true)
if [ -n "$private" ]; then
    echo "FEHLER: Persönliche Depotdaten im Repo: $private"
    failed=1
fi

# .env-Dateien (die Vorlage .env.example ist erlaubt)
env_files=$(git ls-files --cached | grep -E '(^|/)\.env(\..+)?$' | grep -v '\.env\.example$' || true)
if [ -n "$env_files" ]; then
    echo "FEHLER: .env-Datei im Repo: $env_files"
    failed=1
fi

# Typische API-Schlüssel (Anthropic, GitHub, allgemeine "secret"/"api_key"-Zuweisungen)
key_pattern='(sk-ant-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|(api[_-]?key|secret)["'"'"' ]*[:=]["'"'"' ]*[A-Za-z0-9/+_-]{16,})'
if git grep --cached -n -I -i -E "$key_pattern" -- . ':!scripts/check_secrets.sh'; then
    echo "FEHLER: Möglicher Schlüssel gefunden (siehe oben)."
    failed=1
fi

if [ "$failed" -ne 0 ]; then
    exit 1
fi
echo "Keine Depotdaten oder Geheimnisse gefunden."
