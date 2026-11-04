---
"@lpshanley/oidc-start-core": patch
---

Return HTTP 503 when the provider's signing keys cannot be fetched during back-channel logout. Invalid logout tokens still receive HTTP 400.
