# oidc-start

OpenID Connect sign-in for Node.js.

| Package | Public entries |
| --- | --- |
| `@lpshanley/oidc-start-core` | The root exports `createOidcCore`, session types and the revocation contract. Use `/models` for browser-safe user models and `/config` or `/provider` for server configuration and provider calls. |
## Development

Development and CI use Node 26 and pnpm 12.6.0.

```sh
pnpm install --frozen-lockfile
pnpm verify
```
