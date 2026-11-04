# PostgreSQL session storage

This example implements shared revocation and optional refresh coordination for replicas of one app. It uses PostgreSQL 16 and the `pg` driver. The core package has no database dependency.

1. Install `pg` in the host app. Apply [schema.sql](schema.sql) once on the primary using a migration role. Grant the app role SELECT, INSERT and UPDATE on both tables.
2. Copy [store.mjs](store.mjs) into a server-only module. Use a direct or session-pooled connection to the primary. The refresh coordinator holds a session-level advisory lock across a provider request and requires connection affinity. Give the pool finite connection and statement timeouts.
3. Run [cleanup.sql](cleanup.sql) periodically on the primary using a role with DELETE permission. It removes old encrypted results and expired reservations. Subject cutoffs keep one row per subject signed out globally. Retain these through the lifetime of all sessions they could invalidate. Include these tables in your durability and backup policy.

```js
import pg from 'pg'
import { createOidcCore } from '@lpshanley/oidc-start-core'
import { createPostgresStore } from './store.mjs'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
})
const store = createPostgresStore(pool, 'customer-portal:production:primary-issuer')
export const auth = createOidcCore({
  ...store,
  allowSession: user => user.roles?.includes('member') === true,
})
```

Every replica of this app must share the namespace. Separate applications, issuers and client registrations need distinct namespaces. Configure TLS for remote database connections and restrict access to the tables. Refresh rows contain an opaque digest and a briefly reusable sealed result. The database never receives a plaintext refresh token.

To run the integration tests, point `TEST_DATABASE_URL` at a disposable database. Run `pnpm --filter oidc-start-postgres-example test:postgres` from the repository. The tests create a uniquely named schema and remove it afterward. They exercise concurrent writes, out-of-order and duplicate logout events, failure after reserving a refresh, and reuse across independent connections.
