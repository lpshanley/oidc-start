---
"@lpshanley/oidc-start-core": patch
---

Support sign-in and refresh when the provider has no UserInfo endpoint. An email is still required at sign-in, and missing roles are passed to the app's access policy as an empty list.
