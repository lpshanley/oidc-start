---
"@lpshanley/oidc-start-core": patch
---

Idle activity now uses a separate sealed cookie bound to the session, so a delayed response preserves renewed credentials. Form body reads return at their deadline even when another consumer holds a request clone. Confidential clients can select their registered authentication method with `OIDC_TOKEN_ENDPOINT_AUTH_METHOD`. Discovery uses Basic when the issuer omits its supported methods.
