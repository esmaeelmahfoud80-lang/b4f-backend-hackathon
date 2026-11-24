# Initial administrator bootstrap

`npm run admin:bootstrap` provisions the first administrator after database migrations. It is a manual CLI command. Application startup, deployment, and the development demo seed do not invoke it.

## Required environment

Supply these variables privately to the one-off process. The CLI reads the process environment without loading a local `.env`.

| Variable | Value |
| --- | --- |
| `BOOTSTRAP_ADMIN_NAME` | Nonblank display name of up to 120 characters |
| `BOOTSTRAP_ADMIN_PHONE` | Syrian mobile number matching `09[0-9]{8}` |
| `BOOTSTRAP_ADMIN_PASSWORD` | A unique generated password, at least 12 characters excluding surrounding whitespace and at most 72 UTF-8 bytes |
| `DATABASE_URL` | PostgreSQL connection URL for the intended migrated database |

Generate the password in a password manager. For example, use 24 random ASCII characters and store the result there. Inject it through a secret manager or a private process environment. Avoid inline command arguments, shell history, and build or deploy logs.

## Manual invocation after Neon migrations

1. Confirm the intended Neon project, branch, and database. Supply the direct connection URL with TLS as `DATABASE_URL` to the migration process. From the API directory, apply and check the committed migrations with `npx --no prisma migrate deploy --config prisma7.config.ts` and `npx --no prisma migrate status --config prisma7.config.ts`. [Neon connection guidance](https://neon.com/docs/guides/prisma)
2. From the built API directory, inject the four variables into a one-off process and run `npm run admin:bootstrap`. For a local build, run `npm run build` first. On Render, use a manually launched one-off job on a controlled base service or another trusted shell. Render one-off jobs inherit their base service environment, so keep temporary bootstrap secrets off the ordinary web service when possible. [Render one-off jobs](https://render.com/docs/one-off-jobs)
3. Confirm the success message and sign in through `POST /api/v1/auth/admin/login`. Verify the returned account has the `admin` role, then try an admin-only read such as `GET /api/v1/admin/merchants`.
4. Remove the three `BOOTSTRAP_ADMIN_*` variables from the operator shell, secret injection, and any temporary Render environment. Retain the normal API database configuration separately.

## Results and recovery

| Exit status | Meaning |
| --- | --- |
| `0` | Administrator created, or an administrator already existed. The message distinguishes the outcomes. |
| `1` | Connection, target verification, or database operation failed. Check the intended database, migration status, and permissions before retrying. If the final outcome is uncertain, verify admin login or rerun the same command. |
| `2` | Required configuration is missing or invalid, or the target is the protected local development database. |
| `3` | The requested phone already belongs to an account and no administrator exists. Use an unused phone number. |

The command creates an admin-only account using bcrypt with 10 rounds. The transaction takes a PostgreSQL advisory lock before checking for administrators. Another execution must wait for that transaction, then see the committed result. The unique phone constraint handles collisions with public signup. The command leaves existing accounts and credentials intact, including on retries. For an existing administrator with lost credentials, use the project's authorized account recovery process. Re-running bootstrap does not reset credentials.
