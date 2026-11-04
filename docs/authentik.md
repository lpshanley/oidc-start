# Authentik interoperability

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
