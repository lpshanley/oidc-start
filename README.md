# oidc-start

OpenID Connect sign-in and app-managed grants for Node.js, with a TanStack Start adapter for React.

| Package | Public entries |
| --- | --- |
| `@lpshanley/oidc-start-core` | The root exports `createOidcCore`, session types and the revocation contract. Use `/models` for browser-safe user models and `/config` or `/provider` for server configuration and provider calls. |
| `@lpshanley/oidc-start-react` | The root exports request middleware and route handlers. `/server` exposes the current request's OIDC context. |

The host app decides which accounts may hold a session, supplies persistent revocation storage and registers its callback URLs with the provider. The React adapter uses the host's TanStack Start and Router installations.

## Adopting the library

Replace middleware and route imports from the old application packages with `@lpshanley/oidc-start-react`. Import `createOidcCore` from `@lpshanley/oidc-start-core` and `getOidcContext` from `@lpshanley/oidc-start-react/server`. Each host supplies `allowSession` and a revocation store explicitly.

Stellar can keep its cookie prefix, sealing secret, access policy and revocation adapter. Great Sage's older cookie format lacks the session ID and timestamps used for revocation and idle expiry. Plan for users to sign in again when switching from that format. Great Sage's independent provider grants use `startGrant`, `finishGrant` and `refreshGrant`; grant storage and authorization belong to the host.

## Development

Development and CI use Node 26 and pnpm 12.6.0.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

Turbo builds core before the adapter. Verification typechecks both packages, runs the in-process auth tests and checks the distributable packages with publint.
