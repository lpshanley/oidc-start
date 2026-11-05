# @lpshanley/scim-core

A SCIM 2.0 service provider for Node.js servers built on `Request` and `Response`. An identity provider such as Okta or Microsoft Entra ID calls it to create, update and deactivate your users and groups.

The package owns the protocol: validation, PATCH, filters, paging, discovery and SCIM responses. Your app owns tenants, tokens, storage, identity linking and what deprovisioning means.

## Status

This is an early release. It covers Users, Groups and discovery. It was extracted from a production app whose SCIM endpoint has received authentik pushes. **This package itself has not been tested against a live provider, and no real Okta or Entra push has been tested at all**, so try your provider before relying on it.

| Supported | Not supported yet |
| --- | --- |
| `/Users` and `/Groups`: create, read, list, PUT, PATCH, DELETE | Bulk operations and `/Me`, which answer 501 |
| `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | Sorting, ETags and `POST /.search` |
| Bearer tokens, resolved to a connection per request | Filters beyond `eq` clauses joined by `and` |
| The core User and Group schemas, except `password` and `groups`, plus the enterprise extension | Custom schema extensions. Unknown attributes are accepted and not stored |
| `attributes` and `excludedAttributes` on every resource response | Groups as group members |
| Filters on `id`, `userName`, `externalId`, `displayName`, `emails.value` and `emails[type eq "x"].value` | |
| Provider quirks: capitalized `op`, string booleans, no-path PATCH | |

## Mount it

The package needs Node.js 22.12 or newer.

```ts
import { createScim, createScimAdapter } from "@lpshanley/scim-core";

const adapter = createScimAdapter({
	read: (connection) => directoryStore(db, connection),
	transaction: (connection, fn) => db.transaction((tx) => fn(directoryStore(tx, connection), tx)),
});

export const scim = createScim({
	adapter,
	authenticate: (token) => connections.findByTokenDigest(sha256(token)),
	onUserDeprovisioned: (user, { tx }) => deleteMemberData(tx, user),
	onChange: (change, { tx }) => audit(tx, change),
	onCommitted: (change) => roles.clearCache(change),
	onProblem: (problem) => log.warn("scim", problem.kind, problem.status),
});
```

`scim.handle` takes a `Request` and returns a `Response`, so it works anywhere those exist. In TanStack Start, mount it at `src/routes/scim/v2/$.ts`:

```ts
import { createFileRoute } from "@tanstack/react-router";

const handle = async ({ request }: { request: Request }) => {
	const { scim } = await import("../../../scim.server");
	return scim.handle(request);
};

export const Route = createFileRoute("/scim/v2/$")({
	server: { handlers: { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle } },
});
```

Providers authenticate with a bearer token, so exempt this path from any browser CSRF check. If you mount somewhere else, set `basePath`. Behind a proxy that changes the host, set `origin` so resource locations stay correct.

## Options

| Option | Purpose |
| --- | --- |
| `adapter` | Your storage. See [Write an adapter](#write-an-adapter). |
| `authenticate(token, request)` | Returns the connection for a token, or null to answer 401. Compare digests, and never store or log the token. |
| `enabled()` | Answers 404 while false, for example until a token exists. |
| `onUserDeprovisioned(user, context)` | Runs inside the transaction when a user is deactivated or deleted. If it throws, the change rolls back and the provider gets a 503 it can retry. What it returns reaches the change as `details`. |
| `onChange(change, context)` | Runs inside the transaction for every change. Use it for audit rows. |
| `onCommitted(change, context)` | Runs after commit. A failure here can't undo the change, and it is reported to `onProblem`. |
| `onProblem(problem)` | Reports refused and failed requests. A refusal can leave a leaver with access, so alert on these. |
| `basePath`, `origin`, `documentationUri` | Where the routes live and what discovery reports. |

### Behaviour worth knowing

- **Omitted fields on PUT:** a missing `active` or `externalId` keeps its current value, so a sparse update can't reactivate someone or break a link.
- **`externalId` is fixed once set:** changing it answers `400 mutability`, which is stricter than RFC 7643. A deactivation still goes through and keeps the stored value, and the change carries `externalIdConflict`.
- **Storage failures answer 503, never 404:** a 404 would tell the provider the user is gone.
- **Unknown attributes are accepted and dropped:** refusing one would fail the whole request, which might also be a deactivation. `/Schemas` lists what is kept.
- **A typed value is created when missing:** a `replace` of `emails[type eq "work"].value` adds the address if there is none, where RFC 7644 asks for `noTarget`. Other unmatched value paths do answer `noTarget`.
- **A missing `schemas` is accepted:** on any request, which is more lenient than the RFC.
- **A change that changes nothing is skipped:** a PATCH or user PUT that leaves the resource as it was keeps its `lastModified`, and no hook runs.

## Use it without HTTP

`forConnection` gives application code the same operations, with the same transaction and hooks as a provider's request:

```ts
await scim.forConnection(connection).users.deactivate(id);
```

## Write an adapter

A connection is whatever `authenticate` returns, usually one customer's directory. Implement [`ScimStore`](src/adapter.ts) for one connection, and return it from `read` and from `transaction`. Stores must only see that connection's rows.

A user has first-class `emails`, and `attributes` holds the rest of the schema, such as `title`, `phoneNumbers` and the enterprise extension under its URN. Store `attributes` as JSON and return it unchanged. `store.users` must also filter on `id`, `email` and `emailType`, and `testScimAdapter` checks this.

To give hooks your own user fields, such as a linked OIDC subject, return them from the store and pass your type to `createScimAdapter<Connection, MyUser, MyTransaction>`.

## Test it

`@lpshanley/scim-core/testing` has these tools:

```ts
import { createMemoryAdapter, createTestProvider, testScimAdapter } from "@lpshanley/scim-core/testing";
import { expect, test } from "vitest";

// Does my adapter honour the contract? Run this against your real database.
testScimAdapter({
	setup: async () => ({ adapter: await emptyAdapter(), connections: ["acme", "globex"] }),
	test,
});

// Does my app behave when a provider's requests arrive?
test("a leaver loses access", async () => {
	const idp = createTestProvider(scim, { dialect: "entra", token });
	const user = await idp.createUser({ userName: "a@x.test" });
	await idp.deactivate(user);
	expect(await sessions.forUser(user)).toEqual([]);
});
```

`createMemoryAdapter()` is a single-process adapter for trying the package and for fast tests. The `okta`, `okta-wizard`, `entra` and `authentik` dialects are modelled on vendor documentation and that app's records, not captured traffic, so they show your app handles those shapes, not that a real push works. `okta` is an OIN integration, and `okta-wizard` is an App Integration Wizard app, which updates with PUT.

### Capture real traffic

`recordTraffic` wraps an instance and reports each exchange. Headers are never kept, passwords are dropped, and names, emails and filter values become placeholders. `replayTraffic` sends a recording to a fresh instance and returns any exchange whose status changed, so a provider's real requests can become a regression test:

```ts
const recording = readFileSync("okta.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
expect(await replayTraffic(scim, recording, { token })).toEqual([]);
```

Read a recording before you commit it, because an attribute the scrubber doesn't know about keeps its value.

In this repository, `harness/server.mjs` is a throwaway server for this. It keeps users in memory, and it listens on localhost, so a provider needs an HTTPS tunnel to reach it:

```bash
pnpm --filter @lpshanley/scim-core build
cd packages/scim-core
SCIM_HARNESS_TOKEN="$(openssl rand -hex 32)" node harness/server.mjs
```

## Use it with oidc-start

The two packages don't depend on each other, and SCIM users aren't `AuthUser`s: someone can be provisioned before they ever sign in. Linking them is a choice your app makes:

- **Link deliberately.** A SCIM `id` or `externalId` is not automatically an OIDC `(issuer, sub)`. Only treat `externalId` as `sub` if your provider's configuration guarantees it. Linking by email at first sign-in needs a verified email claim from a trusted issuer.
- **Refuse deprovisioned users.** Check your directory in `allowSession`.
- **End current sessions.** Call `SessionRegistry.endAll` once the change commits:

```ts
const scim = createScim({
	// ...
	onCommitted: async (change, { connection }) => {
		if (change.type !== "user.deactivated" && change.type !== "user.deleted") return;
		if (change.user.subject)
			await registry.endAll({ issuer: connection.issuer, clientId: connection.clientId, sub: change.user.subject });
	},
});
```

If `endAll` fails, the change has already committed, and `onProblem` hears about it as `after-commit`. `allowSession` covers that gap, because oidc-start checks it whenever it resolves a session, not only at sign-in. The directory check there must fail closed.
