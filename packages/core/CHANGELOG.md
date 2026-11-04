# @lpshanley/oidc-start-core

## 0.1.0

First stable release of the Node.js OIDC core. Changes since the last prerelease:

- Revocation lookups receive only the app session ID, subject, issue time, and optional provider session ID.
- Providers without a UserInfo endpoint can sign users in using the email in the ID token. Missing roles resolve to an empty list at sign-in and refresh.
- `isAuthorizationDenied(error)` from `@lpshanley/oidc-start-core/provider` recognizes a provider’s `access_denied` authorization response across bundles.

The npm package declares MIT and includes the license text.

## 0.1.0-next.1

- 64096ef: Document how to install the core, handle sign-in and callback cookies, and implement shared session revocation storage.

## 0.1.0-next.0

Initial npm prerelease, including these fixes:

- 455e0db: Require expiration and token ID claims on provider logout tokens. Use the signed issue time for revocation so retries preserve newer sign-ins. Revocation stores must atomically retain the greatest subject cutoff and provider session expiry on out-of-order writes.
- 129a28e: Return a retryable sign-out failure when the revocation store is unavailable and preserve the cookie for retry.
