# oidc-start

OpenID Connect sign-in and app-managed grants for Node.js, with a TanStack Start adapter for React.

| Package | Public entries |
| --- | --- |
| `@lpshanley/oidc-start-core` | The root exports `createOidcCore`, session types and the revocation contract. Use `/models` for browser-safe user models and `/config` or `/provider` for server configuration and provider calls. |
| `@lpshanley/oidc-start-react` | The root exports request middleware and route handlers. `/functions` exports browser-callable server functions. `/server` exposes the current request's OIDC context. |

The host app decides which accounts may hold a session, supplies persistent revocation storage and registers its callback URLs with the provider. The React adapter uses the host's TanStack Start and Router installations.

## Install in an existing TanStack Start app

The packages require Node.js 22.12 or newer. Keep the host's React and TanStack installations. The adapter's peer ranges are `@tanstack/react-start@^1.169.2` and `@tanstack/react-router@^1.170.44`. The [working example](examples/tanstack-start) uses Start 1.169.4 and Router 1.170.46.

Install the `0.1.0-next.0` prerelease from this checkout as two local tarballs. From the **library root**, use Node 26 and pnpm 12.6.0. Set `app_dir` to the absolute path of the consuming app.

```sh
app_dir=/absolute/path/to/your-app
pnpm install --frozen-lockfile
pnpm verify
mkdir -p "$app_dir/vendor"
pnpm --filter @lpshanley/oidc-start-core pack --pack-destination "$app_dir/vendor"
pnpm --filter @lpshanley/oidc-start-react pack --pack-destination "$app_dir/vendor"
```

In the **consuming app**, add this entry to `pnpm-workspace.yaml` (create the file if needed). The packed adapter depends on core by version. This override makes pnpm resolve that dependency to the same local tarball.

```yaml
overrides:
  '@lpshanley/oidc-start-core': 'file:./vendor/lpshanley-oidc-start-core-0.1.0-next.0.tgz'
```

```sh
cd "$app_dir"
pnpm add ./vendor/lpshanley-oidc-start-core-0.1.0-next.0.tgz ./vendor/lpshanley-oidc-start-react-0.1.0-next.0.tgz
```

Keep both archives with the app's manifest and lockfile so CI can run a frozen install. If the app belongs to a larger pnpm workspace, put the override in the workspace root, make its tarball path relative to that root, and add both dependencies to the app package.

## Wire up sign-in

1. **Register the OIDC client.** Use a confidential client with the authorization code flow and PKCE. For a local app served at `http://localhost:5173`, the example's callback URL is `http://localhost:5173/callback` and its post-logout URL is `http://localhost:5173/`. Register the corresponding public HTTPS URLs in production.
2. **Configure the server environment.** Set `APP_ORIGIN` to the app's origin, `OIDC_ISSUER` to the provider's issuer URL, and `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` to the registered credentials. Generate `SESSION_SECRET` once with `openssl rand -hex 32` and persist it across restarts and server instances. The default scopes are `openid profile email offline_access`. The provider must supply an email in the ID token or via UserInfo.
3. **Compose the core on the server.** Start from [auth.server.ts](examples/tanstack-start/src/auth.server.ts). Keep `callbackPath` and `postLogoutPath` aligned with the registered URLs. Set `allowSession` to the host's access policy. For production, implement [SessionRevocations](packages/core/src/revocation.ts) with storage shared by every instance. The example's in-memory implementation is for local development. The [core guide](packages/core/README.md) shows a role-based policy and configuration validation.
4. **Register middleware and the callback.** Copy the middleware order in [src/start.ts](examples/tanstack-start/src/start.ts). A custom Start instance must register `createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" })` before `oidcMiddleware({ core: createServerOnlyFn(() => auth) })` to protect browser RPCs, including sign-out. Mount `GET: handleCallbackRoute()` at [src/routes/callback.ts](examples/tanstack-start/src/routes/callback.ts). Keeping core creation inside a server module lets the browser import the adapter safely.
5. **Connect the UI.** Import `getAuth`, `getSignInUrl` and `signOut` from `@lpshanley/oidc-start-react/functions`. Read `{ user }` in a loader, navigate to the URL returned by `getSignInUrl()` on a sign-in click, and call `signOut()` on a sign-out click. See the [complete route](examples/tanstack-start/src/routes/index.tsx) and the [adapter guide](packages/react/README.md) for optional HTTP handlers.

To check the integration, open `/` in a fresh browser session. It should show **Sign in**. With the provider configured, sign in, confirm the callback returns you to `/` with your name, then sign out and reload. The page should show **Sign in** again.

## Migrating existing applications

Replace middleware and route imports from the old application packages with `@lpshanley/oidc-start-react`. Import `createOidcCore` from `@lpshanley/oidc-start-core` and `getOidcContext` from `@lpshanley/oidc-start-react/server`. Each host supplies `allowSession` and a revocation store explicitly.

Stellar can keep its cookie prefix, sealing secret, access policy and revocation adapter. Great Sage's older cookie format lacks the session ID and timestamps used for revocation and idle expiry. Plan for users to sign in again when switching from that format. Great Sage's independent provider grants use `startGrant`, `finishGrant` and `refreshGrant`; grant storage and authorization belong to the host.

## Development

Development and CI use Node 26 and pnpm 12.6.0.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

Turbo builds core before the adapter. Verification typechecks both packages, runs the in-process auth tests, checks the distributable packages with publint, and builds the TanStack Start example against their public exports. The example checks every emitted client chunk, including lazy routes. The browser must contain the adapter's callable functions and keep the server implementations, OIDC provider, and session cryptography out of the bundle.

Run `pnpm --filter oidc-start-example dev` after verification to try the example. The home page works without credentials. For sign-in, supply the environment variables listed in the core README, set `APP_ORIGIN` to the dev server origin and register `/callback` on that origin with your provider. The example admits any authenticated user and keeps revocations in memory for local development.

## Releases

The root is private. Changesets versions the two public packages together. Run `pnpm changeset` with a user-facing change and `pnpm version-packages` when preparing a release. Before publishing, follow the [consumer install steps](#install-in-an-existing-tanstack-start-app) with both tarballs from the release build.

Check the consumer's dev and production builds, including a browser call to `getAuth`, sign-in, refresh and logout. Publish an approved prerelease with the `next` dist-tag under the `@lpshanley` scope.
