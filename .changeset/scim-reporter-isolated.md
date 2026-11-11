---
"@lpshanley/scim-core": patch
---

A throwing or rejecting `onProblem` callback can no longer reject `handle()` or fail a write that already committed. Reporter failures are now dropped.
