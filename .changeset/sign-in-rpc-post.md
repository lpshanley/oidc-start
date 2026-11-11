---
"@lpshanley/oidc-start-react": minor
---

`getSignInUrl` is now a POST server function and its response carries `Cache-Control: no-store`. It starts a sign-in flow and sets a verifier cookie, so the CSRF middleware now covers it. Calls through `useAuth()` or `getSignInUrl({ data })` need no change; the GET sign-in route is unchanged.
