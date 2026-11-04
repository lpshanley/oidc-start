# Migrating to 0.5

Upgrade core and React together. This minor release intentionally breaks the 0.x storage contract. No compatibility mode reintroduces the old provider-session ban.

## Application sessions

Replace `revocations: SessionRevocations` with `registry: SessionRegistry`. The required methods are `register`, `isActive`, `end`, `endAll`, and `applyLogout`. Every input carries `issuer` and `clientId`. A registered record also carries the random application `sid`, `sub`, optional `idpSid`, and absolute `expiresAt` in epoch seconds. The library registers only at successful authorization. Reads require a live entry; refresh never registers a session.

Atomically order registration and logout mutations within a scope. `applyLogout` must atomically remember the verified event's `jti` through its expiry and delete the matching existing entries. If both subject and provider session are supplied, match both. Duplicate events are successful no-ops. A new authorization after logout may reuse the provider's `sid`. Do not use logout token `iat` as a permanent cutoff. Expiry must be checked during reads even if cleanup is delayed.

Use `createMemorySessionRegistry()` only for single-process development. Copy the updated PostgreSQL example or implement the contract in the host's data layer. Keep provider calls outside registry transactions. Treat the registry as security-sensitive state: a restored database snapshot must not revive previously ended sessions; invalidate browser seals when restoring it.

Session cookies now require format version 2 and contain issuer/client identity. Drain old replicas, rotate `SESSION_SECRET`, and start all new replicas together. Existing browser sessions and pending authorization flows restart. A rollback needs another new secret; never restore the old sealing key. Independently stored grants and their encryption keys are separate.

## Authentication and refresh results

`core.resolve()` returns `status: authenticated | anonymous | denied | unavailable`, the session or null, a bounded reason when unauthenticated, and cookie updates. Only `anonymous` should cause automatic sign-in. The React adapter's `getAuth`/route guards surface 403 for denied admission and 503 for temporary dependency failures. Neither outcome starts another authorization or discards a usable cookie. Callback errors are terminal responses or host-configured error pages.

`SessionRefreshCoordinator.run()` now returns `{ status: 'ready', sealedResult }`, `{ status: 'busy' }`, or `{ status: 'reauth_required' }`. Reserve before dispatch, reuse encrypted successful results briefly, and retain spent reservations through session expiry. A `RefreshNotDispatched` failure can release the reservation for retry. Never dispatch the same uncertain refresh again. A late request cannot clear a peer's newer cookie. Use shared coordination on every production replica; the default in-memory coordinator covers only one process.

## User and host policy

`AuthUser.issuer` is required; `email` is optional. Identify users using issuer and subject, not email. Display helpers fall back to a neutral label. `allowSession` is optional and defaults to accepting authenticated users; applications still enforce their own authorization. A provided admission policy runs on session reads and renewed claims.

`SignOutOptions` replaces the core's trailing boolean and is available through React's functions/hooks and route factory. `everywhere` ends this application's existing browser sessions; `providerLogout` defaults to true. Local logout records the end before clearing the cookie. Explicit browser logout also attempts to retire its own refresh credential. Independently approved offline grants belong to the host and are not automatically revoked by the library.

## Protocol requirements and implementation choices

OIDC Core §11 requires `prompt=consent` for `offline_access` unless established conditions permit offline processing. `offlineAccessConsent` defaults to `prompt`; `preauthorized` requires a documented host/provider basis. The library combines consent with supported standard prompts. `none` cannot be combined with other prompts or with offline consent that has not been preauthorized. Automatic routing to sign-in does not promise interaction-free authorization.

Back-Channel Logout §§2.6–2.8 govern validation, session termination and HTTP responses. Logout algorithms follow ID-token discovery rules; `none` is forbidden. Return 200 only after committed success (including duplicates and no matching sessions), or 400 for invalid/failed logout. Use `Cache-Control: no-store`. Do not substitute 503 in this protocol response; ordinary browser dependency errors still use 503.

The active-session registry, receipt tracking, cookie storage, ten-minute logout-token age limit and default session lifetimes are implementation choices. Receipt checking is optional in OIDC; this implementation uses it to keep redelivery from ending a later session. A distinct delayed valid event can end a newly established matching session; later authorization remains possible. The OP chooses its SSO/invalidation behavior. The library adds no provider-specific logout exceptions or forced-login prompts.

References: [OIDC Core §11](https://openid.net/specs/openid-connect-core-1_0.html#OfflineAccess), [Back-Channel Logout](https://openid.net/specs/openid-connect-backchannel-1_0.html), [RP-Initiated Logout](https://openid.net/specs/openid-connect-rpinitiated-1_0.html).
