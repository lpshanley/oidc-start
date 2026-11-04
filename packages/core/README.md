# @lpshanley/oidc-start-core

OpenID Connect for a Node.js server. Handles discovery, code exchange with PKCE, sealed browser sessions, refresh, revocation and back-channel logout.

```ts
import { createOidcCore } from '@lpshanley/oidc-start-core'
import { hasRole } from '@lpshanley/oidc-start-core/models'

const auth = createOidcCore({
  cookiePrefix: 'myapp',
  callbackPath: '/auth/callback',
  postLogoutPath: '/signed-out',
  allowSession: user => hasRole(user, 'members'),
  revocations: mySessionRevocationStore,
})
auth.assertConfigured()
```

Provide `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and a `SESSION_SECRET` of at least 32 characters. Set `APP_ORIGIN` to the public app origin and `OIDC_ROLES_CLAIM` to the provider's role claim (default `roles`). Register the callback and post-logout URLs. Each app chooses its own role policy and supplies a `SessionRevocations` implementation shared by its server instances. The core checks that policy at sign-in, on session access and after refresh.

Use `startGrant` and `finishGrant` on the server to obtain an independent provider grant. Register a separate `grantCallbackPath` (default `/api/auth/grant-callback`). The sealed state binds each flow to its purpose. The host checks the returned subject and permissions, stores the credentials and decides which client can use them. `refreshGrant` returns `refused` for a provider rejection of the grant. Other errors propagate. A `RefreshNotDispatched` from `/provider` means the refresh request was never sent.

The `/models` entry is safe to import in browser code. Credentials and session management belong on the server.
