---
"@lpshanley/oidc-start-core": patch
---

Report a token refresh that fails after it was sent to the provider. It reaches `onError` as a `refresh` failure with the reason `reauth_required`. A grant the provider ends with `invalid_grant` stays unreported.
