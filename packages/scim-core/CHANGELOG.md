# @lpshanley/scim-core

## 0.7.2

### Patch Changes

- e631865: Group PATCH accepts case-insensitive attribute names in operations without a path. Traffic recordings redact values addressed by mixed-case PATCH keys and personal literals in selectors. Bounded request reads and traffic capture can finish while another consumer holds a request clone.

## 0.7.1

### Patch Changes

- d2345b6: A PATCH that replaces the enterprise `manager` with an empty string now clears it, as Microsoft Entra sends when a manager is removed. It used to keep the previous manager.
- 454f07e: `recordTraffic` no longer reads a request body before the handler has answered, skips requests that fail authentication, keeps at most 1 MiB per body, and can no longer change a response when recording fails.
- c1879f5: `recordTraffic` now matches attribute names without regard to case, as SCIM does, so a `Password`, `Emails` or `Manager` property is scrubbed like its lower-camel-case form.
- b509eec: `recordTraffic` now scrubs PATCH values that are addressed by a path, such as `name.familyName` or `phoneNumbers[type eq "work"].value`, whether the path is the operation's `path` or a key of a no-path value, as Microsoft Entra sends them. It also replaces `externalId`, which Entra fills with a mail alias. A recording made from Entra traffic with an earlier version kept those values.

## 0.7.0

### Patch Changes

- 40ab87d: A throwing or rejecting `onProblem` callback can no longer reject `handle()` or fail a write that already committed. Reporter failures are now dropped.

## 0.6.0

### Minor Changes

- 08b4dc0: Add a SCIM 2.0 service provider for fetch-based servers, with Users, Groups and discovery, per-request connections, transactional deprovisioning hooks, a reactivation change, a choice of mutable or fixed `externalId`, and a testing entry with a memory adapter, adapter contract, provider request shapes and a traffic recorder.
