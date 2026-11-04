# @lpshanley/oidc-start-react

## 0.5.0

### Minor Changes

- Replace lasting session revocations with a scoped active-session registry. Logout ends existing application sessions and deduplicates provider events without prohibiting later authorization using the same provider session ID. Distinguish anonymous, denied, and unavailable session outcomes, and coordinate refreshes without replaying uncertain rotations.

  Add issuer identity, optional email, optional host admission policy, standard prompt combinations and explicit offline-access consent handling. Validate logout signing algorithms against discovery metadata and follow OIDC back-channel response statuses. Introduce configurable local/provider logout and update both adapters and storage examples. See docs/migration-0.5.md before upgrading: this release changes storage contracts and requires a coordinated browser-session cutover.

### Patch Changes

- Updated dependencies
  - @lpshanley/oidc-start-core@0.5.0

## 0.4.3

### Patch Changes

- 2603765: On a successful account switch, discard the previous session's pending cookie writes so the next request uses the newly signed-in account.
- cf4c567: Revoke a single session when its owner signs out with an idle but authentic cookie. A failed revocation preserves the cookie for retry, and account-wide sign-out requires an active session.
- Update the paired core dependency to `@lpshanley/oidc-start-core@0.4.3`.

## 0.4.2

### Patch Changes

- Update the paired core dependency to `@lpshanley/oidc-start-core@0.4.2` for the callback, session policy, deadline, and idle-timeout fixes.

## 0.4.1

### Patch Changes

- a382d19: Show how to compose requireAuth and hasRole for admin navigation and enforce the same role in a private endpoint.
- c7c9ed7: Show how to display a callback error and dismiss it while preserving the rest of the URL and browser history.
- Update the paired core dependency to `@lpshanley/oidc-start-core@0.4.1`.

## 0.4.0

### Minor Changes

- 13fa2a5: Display safe callback messages with authErrorMessage, including for untrusted auth_error query values.
- b0eb61a: Render conditional UI with the SignedIn and SignedOut components.
- fae9cad: Check the current user's role with useAuth().hasRole(role).
- 9c8e9a1: Support signing out of all of the current user's app sessions through the React hook and POST server function.
- c5040ab: Rename OidcAuthProvider to AuthProvider. When upgrading from 0.3.x, update the import from @lpshanley/oidc-start-react/client and the JSX tags. The props are unchanged.
- 776e0b2: Guard route navigation and provide the signed-in user to descendant routes with requireAuth.
- d54bf9c: Guard navigation with requireRecentAuth and carry the required login age through the sign-in route.
- 603834e: Read the loader-backed user with useUser().

### Patch Changes

- @lpshanley/oidc-start-core@0.4.0

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
