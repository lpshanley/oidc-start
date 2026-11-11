---
"@lpshanley/oidc-start-core": minor
---

A malformed `OIDC_REDIRECT_URI` now fails `assertConfigured()` instead of silently falling back to a generated callback URL. In production, `APP_ORIGIN` is required and must use https. A local run of a production build over HTTP needs `OIDC_ALLOW_INSECURE_ORIGIN=true`.
