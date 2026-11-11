# @lpshanley/scim-core

## 0.7.0

### Patch Changes

- 40ab87d: A throwing or rejecting `onProblem` callback can no longer reject `handle()` or fail a write that already committed. Reporter failures are now dropped.

## 0.6.0

### Minor Changes

- 08b4dc0: Add a SCIM 2.0 service provider for fetch-based servers, with Users, Groups and discovery, per-request connections, transactional deprovisioning hooks, a reactivation change, a choice of mutable or fixed `externalId`, and a testing entry with a memory adapter, adapter contract, provider request shapes and a traffic recorder.
