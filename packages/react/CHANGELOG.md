# @lpshanley/oidc-start-react

## 0.3.0

### Minor Changes

- 44d6a77: Add an optional React provider and useAuth hook for loader-backed user data and sign-in and sign-out buttons.
- c741731: Expose classified callback failures and a route-level onError handler for custom responses.
- fcf2dc1: Request recent authentication with maxAge and enforce it in server handlers using checkRecentAuth.
- 37a6e78: Support loginHint and prompt on individual sign-ins, including account selection, while keeping the provider's default SSO behavior.

### Patch Changes

- Updated dependencies [c741731]
- Updated dependencies [fcf2dc1]
- Updated dependencies [37a6e78]
  - @lpshanley/oidc-start-core@0.3.0

## 0.2.0

### Minor Changes

- 4879221: Install just the React adapter in TanStack Start apps. Import browser-safe user models and helpers from the package root, and import `createOidcCore` and the session storage types from `@lpshanley/oidc-start-react/server`.

### Patch Changes

- @lpshanley/oidc-start-core@0.2.0

## 0.1.0

First stable release of the TanStack Start adapter. It depends on `@lpshanley/oidc-start-core@0.1.0`, including its revocation and UserInfo fixes. The npm package declares MIT and includes the license text.

## 0.1.0-next.1

- 5b159fd: Walk through provider registration, middleware, the callback route, and working sign-in and sign-out buttons in a TanStack Start app.
- Updated dependency:
  - @lpshanley/oidc-start-core@0.1.0-next.1

## 0.1.0-next.0

Initial npm prerelease, including these fixes:

- d615e96: Preserve TanStack Start redirects when writing session cookies. In a React event handler, call `useServerFn(signOut)` to follow the redirect to the identity provider.
- 129a28e: Return a retryable sign-out failure when the revocation store is unavailable and preserve the cookie for retry.
