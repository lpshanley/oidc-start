---
"@lpshanley/scim-core": patch
---

`recordTraffic` now matches attribute names without regard to case, as SCIM does, so a `Password`, `Emails` or `Manager` property is scrubbed like its lower-camel-case form.
