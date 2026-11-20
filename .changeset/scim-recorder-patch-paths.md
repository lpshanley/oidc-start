---
"@lpshanley/scim-core": patch
---

`recordTraffic` now scrubs PATCH values that are addressed by a path, such as `name.familyName` or `phoneNumbers[type eq "work"].value`, whether the path is the operation's `path` or a key of a no-path value, as Microsoft Entra sends them. It also replaces `externalId`, which Entra fills with a mail alias. A recording made from Entra traffic with an earlier version kept those values.
