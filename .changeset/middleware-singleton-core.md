---
"@lpshanley/oidc-start-react": minor
---

`oidcMiddleware({ core })` now takes a function with no arguments. It was always called once and cached, so the `context` it received only reflected the first request. The singleton contract is now explicit in the type and the README.
