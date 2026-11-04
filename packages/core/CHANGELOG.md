# @lpshanley/oidc-start-core

## 0.5.0

### Minor Changes

- Replace lasting session revocations with a scoped active-session registry. Logout ends existing application sessions and deduplicates provider events without prohibiting later authorization using the same provider session ID. Distinguish anonymous, denied, and unavailable session outcomes, and coordinate refreshes without replaying uncertain rotations.

  Add issuer identity, optional email, optional host admission policy, standard prompt combinations and explicit offline-access consent handling. Validate logout signing algorithms against discovery metadata and follow OIDC back-channel response statuses. Introduce configurable local/provider logout and update both adapters and storage examples. See docs/migration-0.5.md before upgrading: this release changes storage contracts and requires a coordinated browser-session cutover.

## 0.4.3

### Patch Changes

- cf4c567: Revoke a single session when its owner signs out with an idle but authentic cookie. A failed revocation preserves the cookie for retry, and account-wide sign-out requires an active session.
- a0b767b: Return HTTP 503 when the provider's signing keys cannot be fetched during back-channel logout. Invalid logout tokens still receive HTTP 400.
- 32b77a9: Preserve the session cookie when a refresh misses the request deadline or cannot be dispatched, allowing a concurrent successful refresh to take effect.
- 3d7aea5: Pass an updated email from the refreshed ID token or UserInfo to the host access policy, including when multiple instances share a token refresh.

## 0.4.2

### Patch Changes

- e78757b: Require the host access policy to return or resolve to `true` when issuing, reading, or refreshing a session.
- 36f2974: Bind sign-in and grant callbacks to the initiating browser's sealed verifier cookie. Flows started before the upgrade must be restarted.
- b8e654d: Check request deadlines before starting provider work, preventing an unhandled rejection when a deadline has already passed.
- 062f0a2: Scale last-seen cookie updates to the configured idle timeout so active sessions with short timeouts stay signed in.

## 0.4.1

Versioned together with the React adapter's cookbook updates.

## 0.4.0

Versioned together with the React adapter for its new route guards and UI helpers.

## 0.3.0

### Minor Changes

- c741731: Expose classified callback failures and a route-level onError handler for custom responses.
- fcf2dc1: Request recent authentication with maxAge and enforce it in server handlers using checkRecentAuth.
- 37a6e78: Support loginHint and prompt on individual sign-ins, including account selection, while keeping the provider's default SSO behavior.

## 0.2.0

Core and the React adapter are versioned together. This release pairs core with the adapter's new public exports.

## 0.1.0

First stable release of the Node.js OIDC core. Changes since the last prerelease:

- Revocation lookups receive only the app session ID, subject, issue time, and optional provider session ID.
- Providers without a UserInfo endpoint can sign users in using the email in the ID token. Missing roles resolve to an empty list at sign-in and refresh.
- `isAuthorizationDenied(error)` from `@lpshanley/oidc-start-core/provider` recognizes a provider’s `access_denied` authorization response across bundles.
- Sign-in and grant callbacks now verify the browser’s state and return the provider’s error when authorization ends without a code.
- Multi-replica hosts can provide a shared `refreshCoordinator`. The PostgreSQL example implements coordination and durable session revocation. Single-instance deployments can keep their existing configuration.
- Revocation lookup failures during session resolution now report `revocation-read`. Update monitoring rules that previously counted those failures under `refresh`.

The npm package declares MIT and includes the license text.

## 0.1.0-next.1

- 64096ef: Document how to install the core, handle sign-in and callback cookies, and implement shared session revocation storage.

## 0.1.0-next.0

Initial npm prerelease, including these fixes:

- 455e0db: Require expiration and token ID claims on provider logout tokens. Use the signed issue time for revocation so retries preserve newer sign-ins. Revocation stores must atomically retain the greatest subject cutoff and provider session expiry on out-of-order writes.
- 129a28e: Return a retryable sign-out failure when the revocation store is unavailable and preserve the cookie for retry.
