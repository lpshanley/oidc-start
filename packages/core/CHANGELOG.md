# @lpshanley/oidc-start-core

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
