---
"@lpshanley/oidc-start-core": patch
---

Pass only the session identifiers and issue time to the revocation store. Provider tokens and profile details stay out of revocation lookups.
