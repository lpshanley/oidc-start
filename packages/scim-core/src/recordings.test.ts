import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createScim, type ScimChange, type ScimOptions, type ScimUser } from "./index.js";
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
