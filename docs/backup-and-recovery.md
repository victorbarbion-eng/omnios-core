# Backup and recovery

## Basic level

The implemented backup posture is Basic:

- Keep the code in a private GitHub repository once repository creation is possible.
- Use Supabase's own backup and recovery features for the database.
- Keep `.env` out of Git, keep human credentials in Apple Passwords, and rotate keys when exposure is suspected or access changes.

This is a practical starting point, not a complete disaster-recovery program.

## What Basic does not cover

Basic does **not** currently provide:

- an independent, off-platform export of database data;
- point-in-time recovery unless the selected Supabase plan includes it;
- a documented recovery-time or recovery-point target;
- a tested restore drill;
- a separate backup of local file bytes referenced by `canonical_location` or artifact paths;
- a deployed dashboard backup or image registry, because nothing has been deployed to Vercel.

The database stores pointers to many files rather than copies of their bytes. A database backup therefore cannot restore files that live only on a Mac, Google Drive, or another external location.

## Manual export procedure

Use this only from a trusted machine. `SUPABASE_DB_URL` contains the database password; do not paste it into a shared terminal transcript or commit it.

1. Confirm `pg_dump` is installed locally. It is not required for normal OmniOS setup, but it is required for this manual export.
2. Load the current database URI from your private environment and write an archive outside the repository:

   ```bash
   set -a
   source .env
   set +a
   pg_dump --format=custom --file="$HOME/omnios-backup-$(date +%Y%m%d).dump" "$SUPABASE_DB_URL"
   ```

3. Store the archive in an encrypted location you control. Record the Supabase project, export time, and schema migration level separately from the archive password or key.
4. Confirm the archive exists and has a plausible non-zero size. Do not print its connection string.

A plain SQL export is also possible with `pg_dump --format=plain`, but the custom archive format is generally more convenient for selective inspection and restore through `pg_restore`.

## First restore test

Schedule a first restore test before relying on this posture:

1. Create a disposable Supabase project or isolated PostgreSQL instance.
2. Create a fresh database and restore the archive using `pg_restore` (or the matching Supabase-supported restore path).
3. Check that the expected tables, the `schema_migrations` records, demo/live row counts, and audit events exist.
4. Run read-only checks in the dashboard or direct SQL. Do not point the local runner at the disposable environment until you understand its credentials and ownership.
5. Record what failed, how long the restore took, and whether local file pointers resolve. Update this document after the test.

Until this test is completed, recovery is unverified. Supabase plan capabilities and retention windows should be checked in the project dashboard before relying on them for an incident.

## Recovery priorities

1. Rotate exposed service-role, database, and publishable keys as appropriate.
2. Preserve the existing database and audit evidence before destructive recovery work.
3. Restore database metadata and records using the Supabase plan capability or a tested independent archive.
4. Restore referenced local/external file bytes from their own backup systems.
5. Reconfigure `.env` locally and future deployment secrets with freshly rotated credentials.
6. Verify RLS, the approval guard, audit immutability, and the emergency pause before restarting any runner.
