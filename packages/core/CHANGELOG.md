# @lpshanley/oidc-start-core

## 0.1.0-next.1

- 64096ef: Document how to install the core, handle sign-in and callback cookies, and implement shared session revocation storage.

## 0.1.0-next.0

Initial npm prerelease, including these fixes:

- 455e0db: Require expiration and token ID claims on provider logout tokens. Use the signed issue time for revocation so retries preserve newer sign-ins. Revocation stores must atomically retain the greatest subject cutoff and provider session expiry on out-of-order writes.
- 129a28e: Return a retryable sign-out failure when the revocation store is unavailable and preserve the cookie for retry.
