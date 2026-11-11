---
"@lpshanley/oidc-start-core": patch
---

Back-channel logout now reads at most 16 KiB of an `application/x-www-form-urlencoded` body, enforced while streaming, and refuses a `logout_token` over 8 KiB or one sent more than once. The whole body must arrive within 5 seconds or when the request is aborted, whichever is first. Other encodings get a 400.
