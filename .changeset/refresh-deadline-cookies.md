---
"@lpshanley/oidc-start-core": patch
---

Preserve the session cookie when a refresh misses the request deadline or cannot be dispatched, allowing a concurrent successful refresh to take effect.
