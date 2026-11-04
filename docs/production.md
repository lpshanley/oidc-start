# Running oidc-start in production

## What the session protects

The core is a confidential OIDC web client. The server holds the client secret, exchanges the code using PKCE S256, validates the nonce and binds the callback to a sealed, short-lived browser verifier. Each successful sign-in gets a fresh random app session ID. The browser carries the user and provider tokens in an encrypted, authenticated cookie. Return paths are restricted to the app. A copied cookie is a bearer credential and can be replayed until expiry or revocation.

The host chooses the trusted issuer, registers exact callback URLs, enforces authorization on its own routes and APIs, and protects independently stored grants. Use the issuer and subject to identify an account. The core requires an email claim but does not check that the provider verified ownership of the address. Host policy runs at sign-in, on session reads and after refresh. Provider role changes reach the cookie on refresh. Use host-side authorization or revocation for changes that must apply immediately.

## Cookies, CSRF and time

- Set `APP_ORIGIN` to the canonical **HTTPS** public origin on every replica, including behind a TLS-terminating proxy. An explicit HTTP origin selects insecure cookies even in production. With HTTPS the library uses host-only `__Host-` cookies with `Secure`, `HttpOnly`, `Path=/` and `SameSite=Lax`. The latter permits the top-level GET callback from the provider.
- Protect state-changing browser requests with CSRF checks. For Start, install the server-function CSRF middleware before OIDC middleware and add route-level protection to a form-based sign-out endpoint. Provider back-channel logout authenticates a signed logout token. [Adapter setup](../packages/react/README.md#http-routes-and-server-access)
- Forward every returned `Set-Cookie` separately. The core splits large cookie values at 3,800 encoded characters per chunk. Check the total request and response header limits on your proxy with representative provider tokens.
- Synchronize clocks on the provider, database and app replicas. Sign-in state lasts 10 minutes and accepts timestamps up to 60 seconds in the future. Session expiry and revocation cutoffs use epoch seconds. Provider logout tokens require valid expiry, issue time and token ID, and have a 10-minute maximum age.

## Settings to choose

| Setting | Default | When to change it |
| --- | --- | --- |
| `sessionMaxAgeSeconds` | 14 days | Shorten the absolute lifetime when policy requires more frequent sign-in. Keep it consistent across replicas. |
| `sessionIdleSeconds` | 12 hours | Shorten for shared devices. Last-seen updates on ordinary requests are written at five-minute intervals. Choose an idle limit comfortably above that interval. |
| `OIDC_SCOPES` | `openid profile email offline_access` | Request the profile claims your policy uses. Include the provider's refresh-token scope when sessions must survive access-token expiry. |
| `OIDC_ROLES_CLAIM` | `roles` | Match the claim your provider maps into ID tokens or UserInfo. A missing claim yields an empty role list. |
| `providerTimeoutMs` | 5,000 ms per provider request | Set it within the host request budget. Monitor discovery, token and key endpoint latency. |

## Multiple replicas

Give every instance the same cookie prefix, sealing secret, app origin, issuer, client and session settings. Use one durable revocation namespace for that app and issuer/client. Read from the primary or storage with equivalent read-after-write consistency. A revocation read error makes the request anonymous and preserves its cookie. A failed sign-out write must be retried.

Refreshes start within 30 seconds of access-token expiry. The default coordinator is local to one core instance and reuses a successful refresh for 10 seconds. With multiple workers and a rotating token, two workers can submit the old token independently. Configure the same `refreshCoordinator` on **all** replicas before distributing that traffic. A shared revocation store alone handles logout only. Use a coordinated cutover when enabling the coordinator. [Working PostgreSQL implementation](../examples/postgres/README.md)

The PostgreSQL coordinator reserves each session refresh before contacting the provider. Peers reuse the encrypted result for up to 10 seconds. A stale request after that window receives an anonymous result without a cookie write. If a worker dies after the provider consumes the token and before the database records the result, start a fresh sign-in. An uncertain refresh is never dispatched again by the example. App-managed grants have their own token storage and concurrency requirements.

## Rotating SESSION_SECRET

1. Generate a new secret with `openssl rand -hex 32` and stage it in your secret manager. Use a separate secret per application and environment. The library reads one active key.
2. Drain requests to the old replicas, switch every serving replica to the new secret together, then resume traffic. With a rolling mix of old and new keys either group can reject cookies just written by the other.
3. Sign in through the public origin, access another replica, then sign out. Existing users must sign in again. Any sign-in or independent grant authorization already in flight must restart. A rollback to the old secret can make old, unexpired cookies usable again.

After suspected exposure, retire the compromised key on every replica and revoke affected provider credentials and app-managed grants as appropriate. A key change invalidates the app's old seals. Provider-issued tokens have their own lifetime and revocation process.

## Diagnosing an outage

The default logger emits JSON with the operation and request correlation ID. For example, `oidc.revocation-read.failed` during request resolution points at the revocation store. `oidc.refresh.failed` points at token renewal or its coordinator. Inspect database health for the former, and coordinator and provider health for the latter. The back-channel handler returns 400 for a rejected logout token and 503 for a retryable failure. Count those outcomes separately.

Use `onError` to count failures by `operation`. Count completed callbacks or logouts at the host route if you need success rates. Host integrations using the core directly should inspect callback results and catch sign-in errors. Log bounded operation names and correlation IDs. Raw error objects, headers, callback URLs, state and cookie contents can contain credentials.
