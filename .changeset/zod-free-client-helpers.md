---
"@lpshanley/oidc-start-core": minor
"@lpshanley/oidc-start-react": minor
---

Keep zod out of the browser. `hasRole`, `displayName`, `initials` and `sanitizeReturnPath` now also come from `@lpshanley/oidc-start-core/helpers`, which has no dependencies. Every existing import keeps working.
