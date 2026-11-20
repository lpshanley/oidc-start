---
"@lpshanley/scim-core": patch
---

A PATCH that replaces the enterprise `manager` with an empty string now clears it, as Microsoft Entra sends when a manager is removed. It used to keep the previous manager.
