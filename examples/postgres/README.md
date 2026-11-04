# PostgreSQL session storage

This example implements the active-session registry and shared refresh coordination. The core package remains database-independent. The example uses PostgreSQL 16, `pg`, and the core provider's typed pre-dispatch error.

1. Apply `schema.sql` to a dedicated namespace using your migration system. Give the application SELECT, INSERT, UPDATE and DELETE on these tables.
2. Copy `store.mjs` into a server-only host module. Supply a direct or session-pooled `pg.Pool` with finite connection and statement timeouts; refresh coordination uses session advisory locks and requires connection affinity.
3. Run `cleanup.sql` periodically. Session expiry is checked during reads; cleanup does not determine access. A spent refresh reservation must remain until its absolute session expiry, even after its encrypted result is discarded.

```js
import pg from 'pg'
import { createOidcCore } from '@lpshanley/oidc-start-core'
import { createPostgresStore } from './store.mjs'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
})
export const auth = createOidcCore({
  ...createPostgresStore(pool, 'portal:production'),
  allowSession: user => user.roles?.includes('member') === true,
})
```

The registry stores only identifiers and expiry; it scopes rows by namespace, issuer and client. Short transactions serialize registration and logout. Receipt insertion and session deletion commit together. Provider network calls are outside these transactions. Refresh rows hold a digest and a briefly reusable encrypted result, never plaintext tokens.

All replicas must share the namespace, sealing secret and coordination store. Read from the primary. Use TLS for remote databases. Restoring an old registry backup requires invalidating browser seals so ended sessions cannot be revived.

Set `TEST_DATABASE_URL` to a disposable database and run `pnpm --filter oidc-start-postgres-example test:postgres`. Tests create and remove an isolated schema. They exercise actual transaction rollback, cross-connection locking, stable-provider-session reauthorization, duplicate delivery, expiry, and safe refresh ownership. These are opt-in integration tests, separate from ordinary unit verification.
