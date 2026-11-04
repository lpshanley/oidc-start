---
"@lpshanley/oidc-start-react": patch
---

On a successful account switch, discard the previous session's pending cookie writes so the next request uses the newly signed-in account.
