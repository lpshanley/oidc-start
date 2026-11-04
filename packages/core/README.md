# @lpshanley/oidc-start-core

OpenID Connect sign-in for Node.js servers. The core handles discovery, authorization code exchange with PKCE, browser flow binding, sealed session cookies, refresh coordination and provider logout. Applications supply shared session storage and their own authorization policy.

For TanStack Start use `@lpshanley/oidc-start-react`. See the [production guide](https://github.com/lpshanley/oidc-start/blob/main/docs/production.md), [PostgreSQL example](https://github.com/lpshanley/oidc-start/tree/main/examples/postgres), and [0.5 migration guide](https://github.com/lpshanley/oidc-start/blob/main/docs/migration-0.5.md).

## Configuration

Use Node.js 22.12 or newer, ES modules, and a confidential authorization-code client. Register exact sign-in and post-logout URLs at the provider. Use HTTPS in production.

| Setting | Purpose |
| --- | --- |
| `APP_ORIGIN` | Canonical public origin, such as `https://app.example.com`. |
| `OIDC_ISSUER` | Exact discovery issuer, including tenant path and trailing slash when applicable. |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Registered confidential client credentials. |
| `SESSION_SECRET` | Persistent sealing secret, at least 32 characters, shared by every replica. |
| `OIDC_SCOPES` | Defaults to `openid profile email offline_access`. Email remains optional. |
| `OIDC_ROLES_CLAIM` | Defaults to `roles`; absent roles become an empty list. |

```ts
import { createOidcCore } from '@lpshanley/oidc-start-core'
import { hasRole } from '@lpshanley/oidc-start-core/models'
import { registry, refreshCoordinator } from './sessions.js'

export const auth = createOidcCore({
  cookiePrefix: 'myapp',
  callbackPath: '/callback',
  postLogoutPath: '/',
  registry,
  refreshCoordinator,
  allowSession: user => hasRole(user, 'members'),
})
auth.assertConfigured()
```

`allowSession` is optional; omitted, it admits authenticated users. A provided policy runs on session reads and renewed claims. The default browser lifetime is 14 days absolute and 12 hours idle, configurable with `sessionMaxAgeSeconds` and `sessionIdleSeconds`.

`offlineAccessConsent` defaults to `prompt`: requesting offline access includes `prompt=consent`. Use `preauthorized` only with an established host/provider basis. Standard prompt combinations are supported; `none` is exclusive and incompatible with an offline consent request that has not been preauthorized. An automatic sign-in may still require provider interaction.

## Browser requests

- `auth.resolve(request, context?)` returns cookies, session, `setCookies`, and an authentication status. Only `anonymous` should trigger automatic sign-in. Treat `denied` as 403 and `unavailable` as a retryable 503. Preserve the returned cookie behavior.
- `auth.signIn(request, cookies, options?, context?)` returns the provider URL and verifier cookies. Options include local `returnPathname`, `loginHint`, `prompt`, and `maxAge`.
- `auth.callback(request, cookies, context?)` validates the response, registers a fresh session, and returns either a redirect location or a bounded failure reason. A failed callback is terminal; do not automatically restart it.
- `auth.signOut(request, cookies, session, context?, options?)` ends local registry entries before clearing cookies. `options.everywhere` ends this application's existing sessions for the subject. `options.providerLogout` defaults to true; false performs local logout. Use a CSRF-protected POST and a 303 redirect. A storage failure must not be reported as successful logout.

Forward every `Set-Cookie` separately, including on redirects and error responses. Full sessions contain provider tokens and must stay server-side. `AuthUser` includes issuer and subject, with optional email; browser-safe models and display helpers are exported from `/models`.

## Active-session registry

Implement `SessionRegistry` with shared, durable, read-after-write consistent storage. Every method is scoped by issuer and client ID. All expiry times use epoch seconds.

| Method | Responsibility |
| --- | --- |
| `register(record)` | Add a fresh application session with subject, optional provider `idpSid`, and absolute expiry. |
| `isActive(key)` | Check application session membership and expiry at read time. |
| `end(key)` | End one application session. |
| `endAll(subject)` | End the subject's currently registered sessions in this scope. |
| `applyLogout(event)` | Atomically remember the verified event through expiry and end its current matches. Duplicate events are no-ops. |

Serialize registration and logout mutations. Match both subject and provider session when both are supplied. Never use a lasting provider-session ban or a logout timestamp cutoff. A new authorization can reuse the same provider `sid`. Propagate storage errors. Use `createMemorySessionRegistry()` only for local development or tests.

For provider logout, mount a POST endpoint accepting `logout_token` and call `auth.backchannelLogout(request)`. Return its 200/400 status and `Cache-Control: no-store`. The signed token authenticates this server-to-server request; it does not use browser CSRF credentials. See the migration guide for the normative validation and response requirements.

## Refresh coordination

The default coordinator covers one process. Configure the same durable `SessionRefreshCoordinator` on every replica before distributing traffic. `run` returns a ready sealed result, temporary busy state, or a requirement to reauthorize. Reserve before dispatch; never replay an uncertain rotation. A pre-dispatch `RefreshNotDispatched` exception can release the reservation for retry. The PostgreSQL example demonstrates the contract and its integration tests.

## Independent grants

`startGrant`, `finishGrant`, and `refreshGrant` obtain credentials for host-managed provider access independently of browser session storage. Check returned identity and permissions before storing credentials. A refused refresh requires renewed authorization; other failures propagate. The host decides grant lifetime and explicit revocation. Browser-session logout does not automatically revoke independent offline grants.

## Diagnostics

`onError` receives the operation, bounded reason when available, original error, and caller context. Log only bounded operation/reason values and correlation IDs; provider errors can contain credentials. `isAuthorizationDenied` from `/provider` recognizes a provider's `access_denied` response across bundles. Use identity `(issuer, sub)`, never email, for authorization.
