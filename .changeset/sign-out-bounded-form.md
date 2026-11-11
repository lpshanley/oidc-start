---
"@lpshanley/oidc-start-core": patch
"@lpshanley/oidc-start-react": patch
---

The sign-out route reads its form through a size-limited, time-limited reader instead of `request.formData()`. Core now exports `readFormBody` for this.
