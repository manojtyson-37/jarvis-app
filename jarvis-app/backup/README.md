# maya-db-backups

Nightly encrypted backup of the Maya (`maya-jarvis`) Supabase database, `public` schema.

- Runs daily at 02:00 IST (`30 20 * * *` UTC) and on demand (Actions → nightly-db-backup → Run workflow).
- Output: one `maya-public-<timestamp>.dump.age` file per run, kept as a workflow artifact for 30 days.
- Encrypted with [age](https://age-encryption.org) to a public key. The private key is not stored in GitHub; it lives in the owner's password manager. Without it a backup cannot be opened.
- The workflow fails (and GitHub emails the owner) if the dump is unreadable, has no table data, or is suspiciously small.
- Required secret: `SUPABASE_DB_URL` (session-pooler connection string, port 5432, with the database password).

## Restore

```bash
gh run download --repo manojtyson-37/maya-db-backups -n maya-db-backup   # latest run, or add a run id
age -d -i ~/.maya-backup-age.key maya-public-<timestamp>.dump.age > restore.dump
createdb maya_restore
pg_restore --no-owner --dbname maya_restore restore.dump
```

Restore into a scratch database first and check row counts before touching production.
