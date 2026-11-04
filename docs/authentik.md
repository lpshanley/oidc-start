# Authentik interoperability

## 0.5.0 session registry

On November 4, 2026, the 0.5.0 candidate passed the opt-in check in
`examples/postgres/authentik-check.mjs` with Authentik **2026.8.5**, PostgreSQL
**16**, Chromium, and two independent core instances with separate database pools.
The release tag `v0.5.0` identifies the tested implementation; the release workflow
also checks the exact packed core and React archives in development and production.

The check uses Authentik's default implicit-consent authorization flow and
**default provider invalidation flow**, with back-channel logout enabled. It
verifies automatic protected-route sign-in, `prompt=consent` for offline access,
shared rotating refresh, actual provider back-channel delivery, rejection of a
saved cookie after logout, immediate sign-in with the **same provider sid**, and
duplicate delivery leaving the newly registered session active. Tokens and session
identifiers are compared in memory, never printed.

Authentik's default invalidation flow displays its logout page while keeping its
main SSO session. The browser check explicitly returns to the application from
that page, then starts authorization again. It does not change Authentik's flow,
force `prompt=login`, or suppress automatic sign-in. A provider requiring consent
or another interaction remains free to display it. The library sends the consent
prompt; Authentik's configured authorization flow controls its consent UI.

To repeat, start disposable Authentik 2026.8.5 server/worker containers with
PostgreSQL, expose Authentik on `localhost:19871`, and enable its default blueprints.
Pipe `examples/postgres/authentik-fixture.py` into `ak shell` in that disposable
server. The script creates a fixture client and user with **test-only credentials**,
25-second access tokens, strict callback URLs, and a back-channel URL using
`host.docker.internal:19872`. On Linux, supply that Docker host mapping. Do not
run the provisioning script against an existing or production provider.

Build the library and install Chromium, then run:

```sh
TEST_DATABASE_URL=postgres://... pnpm --filter oidc-start-postgres-example exec node authentik-check.mjs
```

Use a disposable database. The check creates an isolated schema, starts a local
HTTP fixture on port 19872, and removes its schema at completion. The PostgreSQL
contract checks run separately with `pnpm --filter oidc-start-postgres-example
test:postgres`. The packed-package React browser tests use `oidc-provider`; they
are complementary to this real Authentik test.

## Historical 0.1.0 check

The 0.1.0 release candidate was exercised on November 4, 2026 with Authentik 2026.8.5, PostgreSQL 16 and Chromium. The test used a disposable Authentik instance, a confidential client and the TanStack Start example.

| Path | Observed result |
| --- | --- |
| Sign-in | The example discovered the per-application issuer, redirected through Authentik's login flow, exchanged the code with PKCE and displayed the test user's name. |
| Refresh | Reloading with a short-lived access token renewed both the access token and the rotating refresh token. |
| Two replicas | Two independent core instances received the same near-expiry cookie. With separate pools connected to the same PostgreSQL store, both resolved to the same new access and refresh tokens. Sign-out on one replica caused the other to reject replay of the original cookie. |
| Browser sign-out | The sign-out button navigated Chromium to Authentik's provider invalidation flow. Returning to the app and replaying the previously authenticated cookie left the browser signed out. |

These results cover interactive sign-in, refresh and app sign-out. Authentik-initiated back-channel logout was outside this browser run. The core suite separately exercises signed logout tokens and duplicate delivery.

## Repeat the browser check

1. In a disposable Authentik instance, create an OAuth2/OpenID provider and an application with slug `oidc-start`. Select a confidential client with authorization code and refresh grants, the default implicit-consent authorization flow, the default provider invalidation flow, and an asymmetric signing key. Enable the `openid`, `email`, `profile` and `offline_access` scope mappings. [Authentik provider configuration](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/)
2. Register a strict redirect URI of `http://127.0.0.1:19872/callback`. Use a test account with a name and email. For this check set access-token validity to `seconds=25` and refresh-token rotation threshold to `seconds=0` so a reload exercises renewal.
3. Set the example's server environment. Use `APP_ORIGIN=http://127.0.0.1:19872` and `OIDC_ISSUER=http://localhost:19871/application/o/oidc-start/` if running Authentik on local port 19871. Keep the trailing slash and use the exact issuer advertised in discovery. Supply the registered client ID, secret and a generated session secret. Set `OIDC_ROLES_CLAIM=groups` if using Authentik's profile group mapping.
4. Build the packages with `pnpm verify`, then run `pnpm --filter oidc-start-example dev --host 127.0.0.1 --port 19872 --strictPort`. Sign in, reload to exercise refresh, and sign out. Confirm that a saved copy of the original session cookie is rejected. Use HTTPS origins and your normal token lifetimes for a deployed app.
5. To exercise two replicas, configure both with the same sealing secret and [PostgreSQL store](../examples/postgres/README.md). Submit the same near-expiry cookie concurrently to both. Compare the resulting tokens in memory, then sign out on one and replay the original cookie on the other. Keep cookies and tokens out of logs.
