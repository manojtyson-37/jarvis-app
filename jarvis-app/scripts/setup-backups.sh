#!/usr/bin/env bash
# One-time setup for the nightly Maya DB backup. Run it from your own terminal:
#   cd "/Users/manojaaa/Documents/Manoj OS/jarvis-app" && bash scripts/setup-backups.sh
#
# It: (1) creates the private repo manojtyson-37/maya-db-backups if missing, (2) pushes the backup
# workflow from ./backup, (3) asks for the Supabase DB password (hidden, never echoed or logged),
# (4) tests the connection, (5) stores the connection string as the GitHub secret SUPABASE_DB_URL and
# as SUPABASE_DB_URL in .env.local, (6) runs the workflow once and waits for it.
set -euo pipefail
umask 077   # every file this script creates (including .env.local.tmp) is private to you

REPO="manojtyson-37/maya-db-backups"
REF="ljihgdrmxqnhwnvucvpu"
POOLER_HOST="aws-0-ap-south-1.pooler.supabase.com"   # session pooler: IPv4, supports pg_dump
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GIT_GH=(git -c "credential.helper=!gh auth git-credential")

gh auth switch -u manojtyson-37 >/dev/null

echo "1/6 repo"
if ! gh repo view "$REPO" >/dev/null 2>&1; then
  gh repo create "$REPO" --private --description "Nightly encrypted backup of the Maya Supabase DB"
fi

echo "2/6 push workflow"
tmp="$(mktemp -d)"
envfile="$HERE/.env.local"
# $envfile.tmp briefly holds the service key and the DB password: always remove it, even on failure.
trap 'rm -rf "$tmp" "$envfile.tmp"' EXIT
"${GIT_GH[@]}" clone "https://github.com/$REPO.git" "$tmp/repo" 2>/dev/null
mkdir -p "$tmp/repo/.github/workflows"
cp "$HERE/backup/.github/workflows/backup.yml" "$tmp/repo/.github/workflows/backup.yml"
cp "$HERE/backup/README.md" "$tmp/repo/README.md"
(
  cd "$tmp/repo"
  git checkout -B main >/dev/null 2>&1
  git add -A
  if git diff --cached --quiet; then
    echo "   workflow already up to date"
  else
    git -c user.name="manojtyson-37" -c user.email="manojtyson-37@users.noreply.github.com" \
      commit -q -m "Nightly encrypted Supabase backup workflow"
    "${GIT_GH[@]}" push -q -u origin main
  fi
)

echo "3/6 database password"
echo "   Supabase dashboard > maya-jarvis > Project Settings > Database. Reset it there if you do not have it"
echo "   (safe: the app talks to Supabase over the REST API, not a direct database login)."
read -rs -p "   Database password: " PW
echo
[ -n "$PW" ] || { echo "empty password" >&2; exit 1; }
ENC="$(printf '%s' "$PW" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read(), safe=""))')"
URL="postgresql://postgres.${REF}:${ENC}@${POOLER_HOST}:5432/postgres?sslmode=require"
unset PW ENC

echo "4/6 test connection"
psql "$URL" -Atc "select 'connected to ' || current_database() || ', public tables: ' || count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'"

echo "5/6 store secret"
printf '%s' "$URL" | gh secret set SUPABASE_DB_URL --repo "$REPO"
touch "$envfile"
grep -v '^SUPABASE_DB_URL=' "$envfile" > "$envfile.tmp" || [ $? -eq 1 ]   # 1 = no lines left (fine); >1 = real error, abort
printf 'SUPABASE_DB_URL=%s\n' "$URL" >> "$envfile.tmp"
# .env.local holds every app secret: only replace it if the new file has all the other lines plus the new one.
[ "$(wc -l < "$envfile.tmp")" -eq "$(( $(grep -vc '^SUPABASE_DB_URL=' "$envfile" || true) + 1 ))" ] \
  || { echo "   .env.local rewrite check failed; .env.local left untouched" >&2; exit 1; }
mv "$envfile.tmp" "$envfile"
chmod 600 "$envfile"
unset URL

echo "6/6 first backup run"
gh workflow run nightly-db-backup --repo "$REPO"
sleep 8
gh run watch --repo "$REPO" "$(gh run list --repo "$REPO" --workflow nightly-db-backup --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status

echo
echo "Done. Last step, only you can do it: save the backup decryption key in your password manager."
echo "  pbcopy < ~/.maya-backup-age.key     # copies it to the clipboard, then paste it into the password manager"
