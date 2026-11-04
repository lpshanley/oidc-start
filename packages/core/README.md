# @lpshanley/oidc-start-core

OpenID Connect for a Node.js server.

```ts
import { createOidcCore } from '@lpshanley/oidc-start-core'
import { hasRole } from '@lpshanley/oidc-start-core/models'

const auth = createOidcCore({
  cookiePrefix: 'myapp',
  callbackPath: '/auth/callback',
  allowSession: user => hasRole(user, 'members'),
  revocations: mySessionRevocationStore,
})
auth.assertConfigured()
```

Provide `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and a `SESSION_SECRET` of at least 32 characters. Set `APP_ORIGIN` to the public app origin and `OIDC_ROLES_CLAIM` to the provider's role claim (default `roles`). Register the callback URL. Each app chooses its own role policy and supplies a `SessionRevocations` implementation shared by its server instances. The core checks that policy at sign-in, on session access.

The `/models` entry is safe to import in browser code. Credentials and session management belong on the server.
