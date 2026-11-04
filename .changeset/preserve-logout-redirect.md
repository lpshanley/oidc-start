---
"@lpshanley/oidc-start-react": patch
---

Preserve TanStack Start redirects when writing session cookies. In a React event handler, call `useServerFn(signOut)` to follow the redirect to the identity provider.
