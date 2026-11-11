---
"@lpshanley/scim-core": patch
---

`recordTraffic` no longer reads a request body before the handler has answered, skips requests that fail authentication, keeps at most 1 MiB per body, and can no longer change a response when recording fails.
