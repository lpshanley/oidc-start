import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createScim, createScimAdapter, ScimConflictError, type ScimChange, type ScimOptions, type ScimProblem, type ScimUser } from "./index.js";
import { createMemoryAdapter, replayTraffic, type ScimExchange } from "./testing.js";

const recording = (name: string): ScimExchange[] =>
	readFileSync(new URL(`../recordings/${name}.jsonl`, import.meta.url), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));

// Captured from a disposable authentik 2026.8.5 with its default SCIM mappings:
// first pushes, a full sync, a user rename, member changes, a deactivation and
// reactivation, a group rename, deletes, and a second full sync that removes a
// user who left the bound group.
test.each(["mutable", "fixed"] as const)("authentik 2026.8.5 traffic replays with a %s externalId", async (externalId) => {
	const changes: ScimChange[] = [];
	const options: ScimOptions<string, ScimUser, undefined> = {
		adapter: createMemoryAdapter<string>(),
		authenticate: async () => "acme",
		externalId,
		onChange: async (change) => void changes.push(change),
	};
	const scim = createScim(options);
	const exchanges = recording("authentik-2026.8.5");
	expect(exchanges).toHaveLength(30);
	expect(await replayTraffic(scim, exchanges)).toEqual([]);

	const directory = scim.forConnection("acme");
	const users = await directory.users.list({}, 0, 100);
	expect(users.items.map((u) => u.active)).toEqual([true]);
	const groups = await directory.groups.list({}, 0, 100);
	expect(groups.items.map((g) => g.members.map((m) => m.id))).toEqual([[users.items[0].id]]);

	// authentik sends externalId on every PUT and never changes it.
	expect(changes.some((c) => "previousExternalId" in c || "externalIdConflict" in c)).toBe(false);
	expect(changes.map((c) => c.type)).toEqual([
		"group.created",
		"user.created",
		"group.created",
		"group.patched",
		"user.created",
		"user.created",
		"group.patched",
		"user.updated",
		"group.patched",
		"group.patched",
		"user.deactivated",
		"user.reactivated",
		"group.patched",
		"group.patched",
		"user.deleted",
		"group.deleted",
		"user.deleted",
	]);
});

// Captured from an Okta trial org with the catalog's "SCIM 2.0 Test App (OAuth
// Bearer Token)" and its default mappings: the credential test, assignments, a
// profile edit, an unassignment and reassignment, a group push with member
// changes and a rename, unlinking the group, and an import.
test.each(["mutable", "fixed"] as const)("Okta SCIM 2.0 test app traffic replays with a %s externalId", async (externalId) => {
	const changes: ScimChange[] = [];
	const options: ScimOptions<string, ScimUser, undefined> = {
		adapter: createMemoryAdapter<string>(),
		authenticate: async () => "acme",
		externalId,
		onChange: async (change) => void changes.push(change),
	};
	const scim = createScim(options);
	const exchanges = recording("okta-scim2-test-app-2026-11");
	expect(await replayTraffic(scim, exchanges)).toEqual([]);

	const directory = scim.forConnection("acme");
	const users = await directory.users.list({}, 0, 100);
	expect(users.items.map((u) => u.active)).toEqual([true, true, true]);
	// Okta's profile edit arrives as a PUT, and the enterprise extension survives it.
	const edited = users.items.find((u) => "title" in u.attributes);
	expect(edited?.attributes).toMatchObject({
		phoneNumbers: [{ type: "work", primary: true }],
		addresses: [{ type: "work", primary: true }],
		"urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { manager: { value: "person-1" } },
	});
	expect((await directory.groups.list({}, 0, 100)).total).toBe(0);

	expect(changes.some((c) => "previousExternalId" in c || "externalIdConflict" in c)).toBe(false);
	expect(changes.map((c) => c.type)).toEqual([
		"user.created",
		"user.created",
		"user.updated",
		"user.deactivated",
		"user.reactivated",
		"user.created",
		"group.created",
		"group.patched",
		"group.patched",
		"group.patched",
		"group.deleted",
	]);
});

// Captured from the same Okta trial org with a classic App Integration Wizard
// app (SAML with SCIM provisioning, HTTP Header authentication). It runs the
// same lifecycle, and uses PUT where the catalog app uses PATCH: deactivation,
// reactivation, and every group change. Several of its group PUTs change nothing.
test.each(["mutable", "fixed"] as const)("Okta classic wizard app traffic replays with a %s externalId", async (externalId) => {
	const changes: ScimChange[] = [];
	const options: ScimOptions<string, ScimUser, undefined> = {
		adapter: createMemoryAdapter<string>(),
		authenticate: async () => "acme",
		externalId,
		onChange: async (change) => void changes.push(change),
	};
	const scim = createScim(options);
	const exchanges = recording("okta-classic-wizard-2026-11");
	expect(exchanges.filter((e) => e.method === "PATCH")).toEqual([]);
	expect(await replayTraffic(scim, exchanges)).toEqual([]);

	const directory = scim.forConnection("acme");
	const users = await directory.users.list({}, 0, 100);
	expect(users.items.map((u) => u.active)).toEqual([true, true, true]);
	expect((await directory.groups.list({}, 0, 100)).total).toBe(0);

	expect(changes.some((c) => "previousExternalId" in c || "externalIdConflict" in c)).toBe(false);
	expect(changes.map((c) => c.type)).toEqual([
		"user.created",
		"user.created",
		"user.updated",
		"user.deactivated",
		"user.reactivated",
		"user.created",
		"group.created",
		"group.replaced",
		"group.replaced",
		"group.deleted",
	]);
});

// Captured from the same Okta trial org with an app built in Okta's newer
// Integration Wizard (SCIM 2.0, Bearer authentication, "Support PATCH for User"
// and "Import User Schema" on). It reads /ResourceTypes and /Schemas before each
// sync, deactivates and reactivates users with a no-path PATCH, still edits a
// profile with GET and PUT, and pushes a group with a replace and an add on
// members. Its group renames repeat the name, so they change nothing.
test.each(["mutable", "fixed"] as const)("Okta newer wizard traffic replays with a %s externalId", async (externalId) => {
	const changes: ScimChange[] = [];
	const options: ScimOptions<string, ScimUser, undefined> = {
		adapter: createMemoryAdapter<string>(),
		authenticate: async () => "acme",
		externalId,
		onChange: async (change) => void changes.push(change),
	};
	const scim = createScim(options);
	const exchanges = recording("okta-integration-wizard-2026-11");
	expect(exchanges.some((e) => e.path.startsWith("/Schemas"))).toBe(true);
	expect(exchanges.some((e) => e.method === "PATCH" && e.path.startsWith("/Users/"))).toBe(true);
	expect(await replayTraffic(scim, exchanges)).toEqual([]);

	const directory = scim.forConnection("acme");
	expect((await directory.users.list({}, 0, 100)).items.map((u) => u.active)).toEqual([true, true, true]);
	expect((await directory.groups.list({}, 0, 100)).total).toBe(0);

	expect(changes.some((c) => "previousExternalId" in c || "externalIdConflict" in c)).toBe(false);
	expect(changes.map((c) => c.type)).toEqual([
		"user.created",
		"user.created",
		"user.created",
		"user.updated",
		"user.updated",
		"user.deactivated",
		"user.reactivated",
		"group.created",
		"group.patched",
		"group.patched",
		"group.patched",
		"group.patched",
		"group.patched",
		"group.deleted",
	]);
});

// Captured from the same Okta trial org (catalog SCIM 2.0 Test App) while the
// harness made writes fail: creates answered 503 and 409, and a deactivation
// answered 503. Okta did not retry any of them, and a failed deactivation
// became a manual task for the admin, so the package must leave the user
// exactly as it was and report the failure. The recording is replayed with the
// same writes failing.
test("Okta traffic with failing writes replays, reports each failure and applies nothing", async () => {
	let fault: "unavailable" | "conflict" | undefined;
	const storage = createMemoryAdapter<string>();
	const adapter = createScimAdapter<string>({
		read: (connection) => storage.read(connection),
		async transaction(connection, fn) {
			const mode = fault;
			fault = undefined;
			if (mode === "unavailable") throw new Error("injected storage failure");
			if (mode === "conflict") throw new ScimConflictError("injected conflict");
			return storage.transaction(connection, fn);
		},
	});
	const problems: ScimProblem[] = [];
	const changes: ScimChange[] = [];
	const options: ScimOptions<string, ScimUser, undefined> = {
		adapter,
		authenticate: async () => "acme",
		onChange: async (change) => void changes.push(change),
		onProblem: (problem) => void problems.push(problem),
	};
	const scim = createScim(options);
	const exchanges = recording("okta-failures-2026-11");
	expect(exchanges.filter((e) => e.status >= 400).map((e) => `${e.method} ${e.status}`)).toEqual(["POST 503", "POST 409", "PATCH 503"]);
	const mismatches = await replayTraffic(scim, exchanges, {
		before: (exchange) => {
			fault = exchange.status === 503 ? "unavailable" : exchange.status === 409 ? "conflict" : undefined;
		},
	});
	expect(mismatches).toEqual([]);

	// Every failure reached the host, and only the 409 is a refusal.
	expect(problems.map(({ kind, method, status, scimType }) => ({ kind, method, status, scimType }))).toEqual([
		{ kind: "failed", method: "POST", status: undefined, scimType: undefined },
		{ kind: "refused", method: "POST", status: 409, scimType: "uniqueness" },
		{ kind: "failed", method: "PATCH", status: undefined, scimType: undefined },
	]);

	// The failed deactivation left that user active, and the retried creates worked.
	const users = await scim.forConnection("acme").users.list({}, 0, 100);
	expect(users.items.map((u) => u.active).sort()).toEqual([false, true]);
	expect(changes.map((c) => c.type)).toEqual(["user.created", "user.created", "user.deactivated"]);
});

// Captured from the disposable authentik 2026.8.5 while the harness made writes
// fail, with a custom property mapping, and across its compatibility modes. It
// holds: a user update that answered 503 six times before succeeding (authentik
// retries through a job queue, unlike Okta), an injected 409 followed by
// authentik's lookup and second create, a real 409 for a user that already
// existed (authentik links to it, and its next update replaces the externalId),
// custom attributes the package does not keep, and the group shapes of the
// AWS, Salesforce and GitLab modes. Every connection recorded here is the
// harness's, so only the failures are injected on replay.
function authentikFailures() {
	let fault: "unavailable" | "conflict" | undefined;
	const storage = createMemoryAdapter<string>();
	const adapter = createScimAdapter<string>({
		read: (connection) => storage.read(connection),
		async transaction(connection, fn) {
			const mode = fault;
			fault = undefined;
			if (mode === "unavailable") throw new Error("injected storage failure");
			if (mode === "conflict") throw new ScimConflictError("injected conflict");
			return storage.transaction(connection, fn);
		},
	});
	const problems: ScimProblem[] = [];
	const changes: ScimChange[] = [];
	return {
		problems,
		changes,
		before: (exchange: ScimExchange) => {
			const detail = (exchange.response as { detail?: string } | undefined)?.detail;
			fault = exchange.status === 503 ? "unavailable" : detail === "injected conflict" ? "conflict" : undefined;
		},
		make: (externalId: "mutable" | "fixed") => {
			const options: ScimOptions<string, ScimUser, undefined> = {
				adapter,
				authenticate: async () => "acme",
				externalId,
				onChange: async (change) => void changes.push(change),
				onProblem: (problem) => void problems.push(problem),
			};
			return createScim(options);
		},
	};
}

test("authentik traffic with failures, a real conflict and custom attributes replays", async () => {
	const run = authentikFailures();
	const scim = run.make("mutable");
	const exchanges = recording("authentik-failures-2026.8.5");
	expect(await replayTraffic(scim, exchanges, { before: run.before })).toEqual([]);

	// Six failed updates and two refused creates reached the host.
	const kinds = (kind: string) => run.problems.filter((p) => p.kind === kind);
	expect(kinds("failed").map((p) => p.method)).toEqual(Array(6).fill("PUT"));
	expect(kinds("refused").map((p) => [p.method, p.status, p.scimType])).toEqual([
		["POST", 409, "uniqueness"],
		["POST", 409, "uniqueness"],
	]);

	const directory = scim.forConnection("acme");
	const users = (await directory.users.list({}, 0, 100)).items;
	// The retried deactivation finally applied, once, to one user.
	expect(users.filter((u) => !u.active)).toHaveLength(1);
	expect(run.changes.filter((c) => c.type === "user.deactivated")).toHaveLength(1);
	// The pre-existing user was re-linked: authentik's update replaced its externalId.
	expect(users.some((u) => u.externalId === "legacy-1")).toBe(false);
	expect(run.changes.some((c) => c.type === "user.updated" && c.previousExternalId === "legacy-1")).toBe(true);
	// The custom mapping's title, phone and enterprise attributes were kept, and the rest dropped.
	const customised = users.find((u) => "title" in u.attributes);
	expect(customised?.attributes).toMatchObject({ title: expect.any(String), phoneNumbers: [{ type: "work" }] });
	expect(Object.keys(customised?.attributes ?? {})).not.toContain("costCenter");
	expect(Object.keys(customised?.attributes ?? {})).not.toContain("urn:example:custom:1.0:User");
});

test("with a fixed externalId, authentik's update of a pre-existing user is refused", async () => {
	const run = authentikFailures();
	const mismatches = await replayTraffic(run.make("fixed"), recording("authentik-failures-2026.8.5"), { before: run.before });
	// The only change in outcome: every update of that user, which would replace legacy-1.
	// Authentik sends one on each sync, so the user would stay stuck.
	expect(mismatches.map((m) => [m.exchange.method, m.exchange.status, m.status])).toEqual([
		["PUT", 200, 400],
		["PUT", 200, 400],
	]);
	expect(new Set(mismatches.map((m) => m.exchange.path)).size).toBe(1);
	expect(run.problems.some((p) => p.kind === "refused" && p.status === 400 && p.scimType === "mutability")).toBe(true);
});

test("a full sync of 305 users pages correctly and changes nothing that did not change", async () => {
	const changes: ScimChange[] = [];
	const options: ScimOptions<string, ScimUser, undefined> = {
		adapter: createMemoryAdapter<string>(),
		authenticate: async () => "acme",
		onChange: async (change) => void changes.push(change),
	};
	const scim = createScim(options);
	const headers = { authorization: "Bearer t", "content-type": "application/scim+json" };
	const send = async (method: string, path: string, body?: unknown) => {
		const response = await scim.handle(
			new Request(`https://app.test/scim/v2${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
		);
		return { status: response.status, body: await response.json() };
	};
	const bodies = Array.from({ length: 305 }, (_, i) => ({
		userName: `user${String(i).padStart(3, "0")}`,
		externalId: `ext-${i}`,
		active: true,
		emails: [{ value: `user${i}@x.test`, type: "work", primary: true }],
	}));
	const ids: string[] = [];
	for (const body of bodies) ids.push((await send("POST", "/Users", body)).body.id);

	// authentik lists 100 at a time until it has seen everything.
	const seen = new Set<string>();
	for (const start of [1, 101, 201, 301]) {
		const page = await send("GET", `/Users?count=100&startIndex=${start}`);
		expect(page.body.totalResults).toBe(305);
		for (const user of page.body.Resources) seen.add(user.id);
	}
	expect(seen.size).toBe(305);

	// Then it sends every user again. Nothing changed, so nothing is reported.
	changes.length = 0;
	for (const [i, body] of bodies.entries()) expect((await send("PUT", `/Users/${ids[i]}`, { ...body, id: ids[i] })).status).toBe(200);
	expect(changes).toEqual([]);
});
