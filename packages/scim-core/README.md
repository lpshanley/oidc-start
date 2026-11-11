# @lpshanley/scim-core

A SCIM 2.0 service provider for Node.js servers built on `Request` and `Response`. An identity provider such as Okta or Microsoft Entra ID calls it to create, update and deactivate your users and groups.

The package owns the protocol: validation, PATCH, filters, paging, discovery and SCIM responses. Your app owns tenants, tokens, storage, identity linking and what deprovisioning means.

## Status

This is an early release. It covers Users, Groups and discovery. It was extracted from a production app whose SCIM endpoint has received authentik pushes, and the package itself has handled live pushes from a disposable authentik 2026.8.5 and from an Okta trial org, using the catalog's SCIM 2.0 Test App, a classic App Integration Wizard app and an app built in the newer Okta Integration Wizard. That traffic is [kept in the repository](https://github.com/lpshanley/oidc-start/tree/main/packages/scim-core/recordings) and replayed in the tests. Failures were tested too: Okta's and authentik's reactions to 503 and 409 answers are recorded below. **No real Entra push has been tested**, so try it before relying on it.

| Supported | Not supported yet |
| --- | --- |
| `/Users` and `/Groups`: create, read, list, PUT, PATCH, DELETE | Bulk operations and `/Me`, which answer 501 |
| `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | Sorting, ETags and `POST /.search`, which answers 405 |
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
| `externalId` | `"mutable"` (the default) or `"fixed"`. See [Behaviour worth knowing](#behaviour-worth-knowing). |
| `basePath`, `origin`, `documentationUri` | Where the routes live and what discovery reports. |

### Behaviour worth knowing

- **Omitted fields on PUT:** a missing `active` or `externalId` keeps its current value, so a sparse update can't reactivate someone or break a link.
- **`externalId` can change:** Entra sends a mail alias as `externalId` by default, and it changes when a person is renamed. The new value is stored, and the change carries `previousExternalId`, so relink there if your app links on it. Removing it is still refused.
- **`externalId: "fixed"` refuses that change:** choose it when your app treats `externalId` as the link to a sign-in identity. A change then answers `400 mutability`, which is stricter than RFC 7643 and fails the whole request, including a rename sent with it. A deactivation still goes through and keeps the stored value, and the change carries `externalIdConflict`.
- **Reactivation is its own change:** an inactive user made active again reports `user.reactivated`, not `user.updated`, so you can restore what `onUserDeprovisioned` ended.
- **Storage failures answer 503, never 404:** a 404 would tell the provider the user is gone. Okta shows its admin the package's own `detail` text, and then does not retry. See [When a request fails](#when-a-request-fails).
- **Unknown attributes are accepted and dropped:** refusing one would fail the whole request, which might also be a deactivation. This includes unknown sub-attributes inside a list entry or `manager`. `/Schemas` lists what is kept.
- **`null` means unassigned:** on POST and PUT, a null value is treated as omitted. A null `userName` is still refused.
- **No `meta.version`:** ETags aren't supported, so responses don't claim a version. Your store still tracks one for your own use.
- **A typed value is created when missing:** a `replace` of `emails[type eq "work"].value` adds the address if there is none, where RFC 7644 asks for `noTarget`. Other unmatched value paths do answer `noTarget`.
- **PATCH paths are checked:** a malformed path answers `invalidPath`, and a path naming `id`, `meta`, `groups` or `schemas` answers `mutability`. A no-path PATCH ignores those keys, because Okta sends the group's `id` when renaming it.
- **A value filter beyond `type` or `value` is dropped:** a path such as `emails[type eq "work" and primary eq true].value` is valid, not applied, and answers 200 like an unknown attribute.
- **Two spellings of one attribute:** if a body has both `active` and `Active`, the canonical spelling wins.
- **A missing `schemas` is accepted:** on any request, which is more lenient than the RFC.
- **A change that changes nothing is skipped:** a PATCH or PUT that leaves the resource as it was keeps its `lastModified`, and no hook runs. Okta's wizard apps send such PUTs for groups.

## Use it without HTTP

`forConnection` gives application code the same operations, with the same transaction and hooks as a provider's request:

```ts
await scim.forConnection(connection).users.deactivate(id);
```

## Write an adapter

A connection is whatever `authenticate` returns, usually one customer's directory. Implement [`ScimStore`](https://github.com/lpshanley/oidc-start/blob/main/packages/scim-core/src/adapter.ts) for one connection, and return it from `read` and from `transaction`. Stores must only see that connection's rows.

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

`createMemoryAdapter()` is a single-process adapter for trying the package and for fast tests. The `okta`, `okta-wizard`, `entra` and `authentik` dialects are modelled on vendor documentation and that app's records, not captured traffic, so they show your app handles those shapes, not that a real push works. The repository's [`recordings/`](https://github.com/lpshanley/oidc-start/tree/main/packages/scim-core/recordings) folder holds captured traffic from authentik and from three Okta app types. All three Okta apps update a profile with a GET and a PUT. The test app and the newer wizard app deactivate and reactivate with a no-path PATCH and change groups with PATCH, and the classic wizard app uses PUT for all of those. `okta` is an OIN integration, and `okta-wizard` is an App Integration Wizard app, which updates with PUT.

### When a request fails

Okta's behaviour, observed against writes that failed ([`recordings/okta-failures-2026-11.jsonl`](https://github.com/lpshanley/oidc-start/blob/main/packages/scim-core/recordings/okta-failures-2026-11.jsonl)):

- **It does not retry.** A create that answered 503 stayed failed for eight minutes, including after the server recovered. The admin has to select the assignment on the Tasks page and press **Retry Selected**, which repeats the lookup and the create.
- **It shows your `detail` text** in the assignment's error, so keep those messages free of anything private.
- **A 409 on create is a plain failure.** Okta does not look the user up again or link them.
- **A failed deactivation becomes a manual task.** Okta creates "Application accounts need deprovisioning" for the admin and sent no retry in the three minutes we watched. Until someone acts, the person is still active in your app. A deactivation sent by unassigning someone and one sent by deactivating them in Okta are the same `PATCH`.

So alert on `onProblem` with `kind: "failed"` for a `PATCH`, `PUT` or `DELETE`. Okta will not try again, and it only raises a task in its own console.

To reproduce a failure against a real provider, the harness can fail writes on demand: write `{"mode":"unavailable","times":2}` (or `"conflict"`) to `harness/fault.json` in the repository's [harness](https://github.com/lpshanley/oidc-start/blob/main/packages/scim-core/harness/server.mjs) while it runs.

### authentik

Observed against authentik 2026.8.5 ([`recordings/authentik-2026.8.5.jsonl`](https://github.com/lpshanley/oidc-start/blob/main/packages/scim-core/recordings/authentik-2026.8.5.jsonl) and [`recordings/authentik-failures-2026.8.5.jsonl`](https://github.com/lpshanley/oidc-start/blob/main/packages/scim-core/recordings/authentik-failures-2026.8.5.jsonl)):

- **It retries failed writes by itself.** A user update that answered 503 was retried through authentik's job queue with growing delays, about one and a half, four and five minutes, and applied about a minute after the server recovered, ten minutes after the first failure. That is the opposite of Okta, so a short outage heals without anyone acting. How long it keeps trying is not known.
- **A 409 on create makes it look the user up by `userName`,** then link to the match, or create again if there is none. A user that already existed is linked and not changed at first. Its next update, and every update in a full sync, then sends authentik's own `externalId`. By default the package stores it. With `externalId: "fixed"` each of those updates answers `400 mutability`, so a pre-existing user whose `externalId` differs stays stuck. Don't pre-create people with a different `externalId` if you choose `"fixed"`.
- **Attributes outside the kept set are dropped.** A custom property mapping sent `costCenter` and a custom schema URN, and the package answered 200 and stored neither. `title`, `phoneNumbers` and the enterprise extension were kept.
- **All seven compatibility modes work:** default, aws, slack, sfdc, gitlab, webex and vcenter. AWS, Salesforce, GitLab and vCenter change groups with `PUT` where the others use `PATCH`, and Webex adds `"type": "user"` to members. Salesforce mode asks for `/ServiceProviderConfigs`, which answers 404 and does no harm.
- **The default full sync runs every four hours** (`49 */4 * * *`), not every hour. It sends a `PUT` for every user, and the package skips the ones that changed nothing.
- **Volume:** 300 new users synced in under two minutes, listing paged correctly at 100 a time, and a full sync of 305 users finished in under a minute with no errors. Authentik itself left two of the 300 unpushed until the next full sync, with no error in either system, so a user can be missing for up to four hours.

### Capture real traffic

`recordTraffic` wraps an instance and reports each exchange. Headers are never kept, passwords are dropped, and names, emails and filter values become placeholders. `replayTraffic` sends a recording to a fresh instance and returns any exchange whose status changed, so a provider's real requests can become a regression test:

```ts
const recording = readFileSync("okta.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
expect(await replayTraffic(scim, recording, { token })).toEqual([]);
```

Read a recording before you commit it, because an attribute the scrubber doesn't know about keeps its value.

In the repository, [`harness/server.mjs`](https://github.com/lpshanley/oidc-start/blob/main/packages/scim-core/harness/server.mjs) is a throwaway server for this. It keeps users in memory, and it listens on localhost, so a provider needs an HTTPS tunnel to reach it:

```bash
pnpm --filter @lpshanley/scim-core build
cd packages/scim-core
SCIM_HARNESS_TOKEN="$(openssl rand -hex 32)" node harness/server.mjs
```

## Use it with oidc-start

The two packages don't depend on each other, and SCIM users aren't `AuthUser`s: someone can be provisioned before they ever sign in. Linking them is a choice your app makes:

- **Link deliberately.** A SCIM `id` or `externalId` is not automatically an OIDC `(issuer, sub)`. Only treat `externalId` as `sub` if your provider's configuration guarantees it, and then set `externalId: "fixed"`. Linking by email at first sign-in needs a verified email claim from a trusted issuer.
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
