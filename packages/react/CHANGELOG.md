# @lpshanley/oidc-start-react

## 0.1.0-next.1

- 5b159fd: Walk through provider registration, middleware, the callback route, and working sign-in and sign-out buttons in a TanStack Start app.
- Updated dependency:
  - @lpshanley/oidc-start-core@0.1.0-next.1

## 0.1.0-next.0

Initial npm prerelease, including these fixes:

- d615e96: Preserve TanStack Start redirects when writing session cookies. In a React event handler, call `useServerFn(signOut)` to follow the redirect to the identity provider.
- 129a28e: Return a retryable sign-out failure when the revocation store is unavailable and preserve the cookie for retry.
