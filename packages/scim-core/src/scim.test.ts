import { describe, expect, test, vi } from "vitest";
import { createScim, createScimAdapter, type ScimChange, type ScimOptions, type ScimStore, type ScimUser } from "./index.js";
import { createMemoryAdapter, createTestProvider, type ScimDialect } from "./testing.js";

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const headers = { authorization: "Bearer test-token" };
const bodyHeaders = { ...headers, "content-type": "application/scim+json" };
const url = (path: string) => `https://app.test/scim/v2${path}`;

function setup(options: Partial<ScimOptions<string, ScimUser, undefined>> = {}) {
	const adapter = createMemoryAdapter<string>();
	const scim = createScim({
		adapter,
		authenticate: async (token) => (token === "test-token" ? "acme" : token === "other-token" ? "globex" : null),
		...options,
	});
	return { adapter, scim };
}
const get = async (scim: ReturnType<typeof setup>["scim"], path: string, init: RequestInit = { headers }) => {
	const response = await scim.handle(new Request(url(path), init));
	const text = await response.text();
	return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
};

describe.each<ScimDialect>(["okta", "okta-wizard", "entra", "authentik"])("%s", (dialect) => {
	test("runs a joiner, mover and leaver", async () => {
		const deprovisioned = vi.fn(async () => {});
		const { adapter, scim } = setup({ onUserDeprovisioned: deprovisioned });
		const idp = createTestProvider(scim, { dialect });

		const alice = await idp.createUser({ userName: "alice@x.test", externalId: "ext-1" });
		const bob = await idp.createUser({ userName: "bob@x.test" });
		const ops = await idp.createGroup("ops", [alice]);
		await idp.addMember(ops, bob);
		await idp.removeMember(ops, alice);
		expect((await idp.getGroup(ops.id)).members.map((m: { value: string }) => m.value)).toEqual([bob.id]);

		await idp.deactivate(alice);
		const stored = await adapter.read("acme").user(alice.id);
		expect(stored).toMatchObject({ active: false, externalId: "ext-1" });
		expect(deprovisioned).toHaveBeenCalledOnce();
		expect(deprovisioned.mock.calls[0]).toMatchObject([{ id: alice.id }, { reason: "deactivated", connection: "acme" }]);

		await idp.reactivate(alice);
		expect((await adapter.read("acme").user(alice.id))?.active).toBe(true);
		await idp.rename(alice, "Alicia");
		expect((await adapter.read("acme").user(alice.id))?.name?.givenName).toBe("Alicia");

		await idp.renameGroup(ops, "operations");
		expect((await idp.getGroup(ops.id)).displayName).toBe("operations");
		expect((await idp.findUser("ALICE@x.test")).totalResults).toBe(1);

		await idp.deleteUser(bob);
		expect((await idp.getUser(bob.id)).status).toBe(404);
		expect((await idp.getGroup(ops.id)).members).toEqual([]);
		expect(deprovisioned).toHaveBeenCalledTimes(2);
	});
});

test("the endpoint stays hidden until enabled, then requires a token", async () => {
	expect((await get(setup({ enabled: async () => false }).scim, "/Users")).status).toBe(404);
	const { scim } = setup();
	for (const authorization of ["", "Basic abc", "Bearer wrong"]) {
		const denied = await get(scim, "/Users", { headers: { authorization } });
		expect(denied.status).toBe(401);
		expect(denied.headers.get("www-authenticate")).toContain("Bearer");
		expect(denied.body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
	}
	const listed = await get(scim, "/Users");
	expect(listed.status).toBe(200);
	expect(listed.headers.get("content-type")).toBe("application/scim+json");
	expect(listed.headers.get("cache-control")).toBe("no-store");
	expect(listed.body).toMatchObject({ totalResults: 0, Resources: [] });
});

test("a token only reaches its own connection", async () => {
	const { scim } = setup();
	const user = await createTestProvider(scim, { dialect: "okta" }).createUser({ userName: "a@x.test" });
	const other = createTestProvider(scim, { dialect: "okta", token: "other-token" });
	expect((await other.getUser(user.id)).status).toBe(404);
	expect((await other.createUser({ userName: "a@x.test" })).userName).toBe("a@x.test");
});

test("responses carry the resource, its location and paging", async () => {
	const { scim } = setup({ origin: "https://public.test" });
	const created = await get(scim, "/Users", {
		method: "POST",
		headers: bodyHeaders,
		body: JSON.stringify({ schemas: [USER], userName: "a@x.test", name: { givenName: "A" }, displayName: "Ay" }),
	});
	expect(created.status).toBe(201);
	expect(created.headers.get("location")).toBe(`https://public.test/scim/v2/Users/${created.body.id}`);
	expect(created.body).toMatchObject({
		userName: "a@x.test",
		displayName: "Ay",
		name: { givenName: "A" },
		active: true,
		meta: { resourceType: "User", version: 'W/"1"' },
	});
	await scim.forConnection("acme").users.create({ userName: "b@x.test" });
	const page = await get(scim, "/Users?startIndex=2&count=1");
	expect(page.body).toMatchObject({ totalResults: 2, startIndex: 2, itemsPerPage: 1 });
	const found = await get(scim, `/Users?filter=${encodeURIComponent('userName eq "A@X.TEST"')}`);
	expect(found.body.totalResults).toBe(1);
	expect((await get(scim, `/Users?filter=${encodeURIComponent('title eq "x"')}`)).body.scimType).toBe("invalidFilter");
});

test("a deactivation wins over a different externalId, which is not stored", async () => {
	const changes: ScimChange[] = [];
	const { adapter, scim } = setup({ onChange: async (change) => void changes.push(change) });
	const users = scim.forConnection("acme").users;
	const user = await users.create({ userName: "a@x.test", externalId: "ext-1" });
	await expect(users.replace(user.id, { userName: "a@x.test", externalId: "other" })).rejects.toMatchObject({
		status: 400,
		scimType: "mutability",
	});
	await users.replace(user.id, { userName: "a@x.test", externalId: "other", active: false });
	expect(await adapter.read("acme").user(user.id)).toMatchObject({ active: false, externalId: "ext-1" });
	expect(changes.at(-1)).toMatchObject({ type: "user.deactivated", externalIdConflict: true });
});

test("an application can deprovision without HTTP, through the same path", async () => {
	const deprovisioned = vi.fn(async () => ({ sessions: 2 }));
	const changes: ScimChange[] = [];
	const { scim } = setup({
		onUserDeprovisioned: deprovisioned,
		onCommitted: async (change) => void changes.push(change),
	});
	const users = scim.forConnection("acme").users;
	const user = await users.create({ userName: "a@x.test" });
	expect((await users.deactivate(user.id)).active).toBe(false);
	await users.deactivate(user.id);
	expect(deprovisioned).toHaveBeenCalledOnce();
	expect(changes.filter((c) => c.type === "user.deactivated")).toMatchObject([{ details: { sessions: 2 } }]);
});

test("a failed deprovisioning rolls everything back and reports a retryable failure", async () => {
	const problems = vi.fn();
	const committed = vi.fn(async () => {});
	const { adapter, scim } = setup({
		onUserDeprovisioned: async () => {
			throw new Error("data store down");
		},
		onCommitted: committed,
		onProblem: problems,
	});
	const idp = createTestProvider(scim, { dialect: "okta" });
	const user = await idp.createUser({ userName: "a@x.test" });
	committed.mockClear();
	const result = await idp.send("PATCH", `/Users/${user.id}`, {
		schemas: [PATCH],
		Operations: [{ op: "replace", value: { active: false } }],
	});
	expect(result.status).toBe(503);
	expect((await adapter.read("acme").user(user.id))?.active).toBe(true);
	expect(committed).not.toHaveBeenCalled();
	expect(problems).toHaveBeenCalledWith(expect.objectContaining({ kind: "failed", method: "PATCH" }));
});

test("storage failures answer 503, never 404, on every route", async () => {
	const failing = new Proxy(
		{},
		{
			get: () => async () => {
				throw new Error("connection refused");
			},
		},
	);
	const { scim } = setup({
		adapter: {
			read: () => failing as never,
			transaction: async () => {
				throw new Error("connection refused");
			},
		},
	});
	for (const path of ["/Users", "/Users/u1", "/Groups", "/Groups/g1"]) expect((await get(scim, path)).status).toBe(503);
	expect((await get(scim, "/Users/u1", { method: "DELETE", headers })).status).toBe(503);
});

test("a hook failing after commit does not fail the request", async () => {
	const problems = vi.fn();
	const { scim } = setup({
		onCommitted: () => {
			throw new Error("cache down");
		},
		onProblem: problems,
	});
	const user = await createTestProvider(scim, { dialect: "okta" }).createUser({ userName: "a@x.test" });
	expect(user.userName).toBe("a@x.test");
	expect(problems).toHaveBeenCalledWith(expect.objectContaining({ kind: "after-commit", method: "POST" }));
});

test("group PATCH applies operations in order, in one transaction", async () => {
	const { scim } = setup();
	const idp = createTestProvider(scim, { dialect: "okta" });
	const [u1, u2] = [await idp.createUser({ userName: "1@x.test" }), await idp.createUser({ userName: "2@x.test" })];
	const group = await idp.createGroup("ops", [u1]);
	const patch = (...Operations: unknown[]) => idp.send("PATCH", `/Groups/${group.id}`, { schemas: [PATCH], Operations });
	const members = async () => (await idp.getGroup(group.id)).members.map((m: { value: string }) => m.value);

	await patch({ op: "remove", path: "members", value: [{ value: u1.id }] }, { op: "add", path: "members", value: [{ value: u1.id }] });
	expect(await members()).toEqual([u1.id]);
	await patch({ op: "add", path: "members", value: [{ value: u2.id }] }, { op: "replace", path: "members", value: [{ value: u2.id }] });
	expect(await members()).toEqual([u2.id]);

	const refused = await patch({ op: "remove", path: "members" }, { op: "add", path: "members", value: [{ value: "missing" }] });
	expect(refused).toMatchObject({ status: 400, body: { scimType: "invalidValue" } });
	expect(await members()).toEqual([u2.id]);
});

test("a PATCH that changes nothing leaves the resource and its history alone", async () => {
	const changes: string[] = [];
	const { scim } = setup({ onChange: async (change) => void changes.push(change.type) });
	const idp = createTestProvider(scim, { dialect: "okta" });
	const alice = await idp.createUser({ userName: "alice@x.test" });
	const group = await idp.createGroup("ops", [alice]);
	const patch = (path: string, ...Operations: unknown[]) =>
		idp.send("PATCH", path, { schemas: [PATCH], Operations });
	changes.length = 0;

	const user = await patch(`/Users/${alice.id}`, { op: "replace", path: "userName", value: "alice@x.test" });
	expect(user.body.meta.version).toBe((await idp.getUser(alice.id)).body.meta.version);
	const before = await idp.getGroup(group.id);
	const same = await patch(
		`/Groups/${group.id}`,
		{ op: "add", path: "members", value: [{ value: alice.id }] },
		{ op: "replace", path: "displayName", value: "ops" },
	);
	expect(same.status).toBe(200);
	expect(same.body.meta).toEqual(before.meta);
	expect(changes).toEqual([]);
});

test("/Me and /Bulk answer 501, and only after authentication", async () => {
	const { scim } = setup();
	expect((await get(scim, "/Me")).status).toBe(501);
	expect((await get(scim, "/Bulk", { method: "POST", headers: bodyHeaders, body: "{}" })).status).toBe(501);
	expect((await get(scim, "/Me", { headers: {} })).status).toBe(401);
});

test("attributes and excludedAttributes shape every resource response", async () => {
	const { scim } = setup();
	const idp = createTestProvider(scim, { dialect: "entra" });
	const alice = await idp.createUser({ userName: "alice@x.test", givenName: "Alice", familyName: "Example" });
	const group = await idp.createGroup("ops", [alice]);

	const one = await get(scim, `/Users/${alice.id}?attributes=userName,name.givenName`);
	expect(one.body).toEqual({
		schemas: [USER],
		id: alice.id,
		userName: "alice@x.test",
		name: { givenName: "Alice" },
	});
	const prefixed = await get(scim, `/Users/${alice.id}?attributes=${USER}:USERNAME`);
	expect(Object.keys(prefixed.body)).toEqual(["schemas", "id", "userName"]);
	const list = await get(scim, "/Groups?excludedAttributes=members");
	expect(list.body.Resources[0].members).toBeUndefined();
	expect(list.body.totalResults).toBe(1);
	expect((await get(scim, `/Groups/${group.id}?excludedAttributes=members,id`)).body).toMatchObject({ id: group.id });
	const sub = await get(scim, `/Groups/${group.id}?excludedAttributes=members.display`);
	expect(sub.body.members[0]).toEqual({ value: alice.id, $ref: expect.any(String) });
	const patched = await get(scim, `/Users/${alice.id}?attributes=active`, {
		method: "PATCH",
		headers: bodyHeaders,
		body: JSON.stringify({ schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: false }] }),
	});
	expect(patched.body).toEqual({ schemas: [USER], id: alice.id, active: false });
});

test("what a provider sends comes back, including the enterprise schema", async () => {
	const { scim } = setup();
	const idp = createTestProvider(scim, { dialect: "okta" });
	const ent = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
	const created = await idp.send("POST", "/Users", {
		schemas: [USER, ent],
		userName: "alice@x.test",
		title: "CTO",
		emails: [{ type: "work", value: "alice@x.test", primary: true }],
		[ent]: { department: "Eng" },
	});
	expect(created.body).toMatchObject({
		schemas: [USER, ent],
		title: "CTO",
		emails: [{ type: "work", value: "alice@x.test", primary: true }],
		[ent]: { department: "Eng" },
	});
	const plain = await idp.send("POST", "/Users", { schemas: [USER], userName: "bob@x.test" });
	expect(plain.body.schemas).toEqual([USER]);
	expect(plain.body.emails).toBeUndefined();
});

test("the lookups Entra can match on find the right user", async () => {
	const { scim } = setup();
	const idp = createTestProvider(scim, { dialect: "entra" });
	const alice = await idp.createUser({ userName: "alice@x.test", externalId: "ext-1" });
	await idp.createUser({ userName: "bob@x.test" });
	const found = async (filter: string) =>
		(await get(scim, `/Users?filter=${encodeURIComponent(filter)}`)).body.Resources.map((u: { id: string }) => u.id);
	expect(await found('emails[type eq "work"].value eq "ALICE@x.test"')).toEqual([alice.id]);
	expect(await found(`id eq "${alice.id}"`)).toEqual([alice.id]);
	expect(await found('userName eq "alice@x.test" and externalId eq "ext-1"')).toEqual([alice.id]);
	expect(await found('userName eq "alice@x.test" and externalId eq "other"')).toEqual([]);
});

test("discovery describes every attribute the package keeps", async () => {
	const { scim } = setup();
	const ent = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
	const { body } = await get(scim, "/Schemas");
	expect(body.Resources.map((s: { id: string }) => s.id)).toEqual([USER, ent, GROUP]);
	const user = body.Resources[0].attributes;
	expect(user.map((a: { name: string }) => a.name)).toEqual(expect.arrayContaining(["emails", "title", "addresses"]));
	expect(user.map((a: { name: string }) => a.name)).not.toContain("password");
	for (const schema of body.Resources)
		for (const attribute of schema.attributes) expect(attribute.description, attribute.name).toEqual(expect.any(String));
	expect((await get(scim, "/ResourceTypes/User")).body.schemaExtensions).toEqual([{ schema: ent, required: false }]);
});

test("group PUT keeps an externalId it omits, and replaces members", async () => {
	const { adapter, scim } = setup();
	const groups = scim.forConnection("acme").groups;
	const group = await groups.create({ displayName: "ops", externalId: "g-1", memberIds: [] });
	const put = await get(scim, `/Groups/${group.id}`, {
		method: "PUT",
		headers: bodyHeaders,
		body: JSON.stringify({ schemas: [GROUP], displayName: "platform" }),
	});
	expect(put.body.displayName).toBe("platform");
	expect((await adapter.read("acme").group(group.id))?.externalId).toBe("g-1");
});

test("duplicates answer 409 and refusals are reported, but a missing resource is not", async () => {
	const problems = vi.fn();
	const { scim } = setup({ onProblem: problems });
	const idp = createTestProvider(scim, { dialect: "okta" });
	await idp.createUser({ userName: "a@x.test" });
	const duplicate = await idp.send("POST", "/Users", { schemas: [USER], userName: "A@X.TEST" });
	expect(duplicate).toMatchObject({ status: 409, body: { scimType: "uniqueness" } });
	expect(problems).toHaveBeenCalledWith(expect.objectContaining({ kind: "refused", status: 409 }));
	problems.mockClear();
	expect((await idp.getUser("missing")).status).toBe(404);
	expect(problems).not.toHaveBeenCalled();
});

test("bodies must be typed, parseable and small", async () => {
	const { scim } = setup();
	const post = (body: string, type = "application/scim+json") =>
		get(scim, "/Users", { method: "POST", headers: { ...headers, "content-type": type }, body });
	expect((await post("{}", "text/plain")).status).toBe(415);
	expect((await post("{", "application/json")).body.scimType).toBe("invalidSyntax");
	expect((await post(`{"pad":"${"x".repeat(1 << 20)}"}`)).status).toBe(413);
});

test("discovery lists resources and serves each one as a plain object", async () => {
	const { scim } = setup({ documentationUri: "https://app.test/docs" });
	expect((await get(scim, "/ServiceProviderConfig")).body).toMatchObject({
		documentationUri: "https://app.test/docs",
		patch: { supported: true },
		bulk: { supported: false },
		authenticationSchemes: [{ type: "oauthbearertoken" }],
	});
	const types = await get(scim, "/ResourceTypes");
	expect(types.body.totalResults).toBe(2);
	const schemas = await get(scim, "/Schemas");
	expect(schemas.body.Resources).toHaveLength(3);
	for (const location of [...types.body.Resources, ...schemas.body.Resources].map((r) => r.meta.location as string)) {
		const one = await get(scim, location.split("/scim/v2")[1]);
		expect(one.status).toBe(200);
		expect(one.body.Resources).toBeUndefined();
		expect(one.body.meta.location).toBe(location);
	}
	expect((await get(scim, `/Schemas/${USER.replaceAll(":", "%3A")}`)).status).toBe(200);
	expect((await get(scim, "/ResourceTypes/Nope")).status).toBe(404);
	expect((await get(scim, '/Schemas?filter=id eq "x"')).status).toBe(403);
});

test("paths outside the mount and unsupported methods are refused", async () => {
	const { scim } = setup();
	expect((await scim.handle(new Request("https://app.test/scimmy/Users", { headers }))).status).toBe(404);
	expect((await get(scim, "/Users/a/b")).status).toBe(404);
	expect((await get(scim, "/Users/%E0%A4%A")).status).toBe(404);
	expect((await get(scim, "/Nope")).status).toBe(404);
	expect((await get(scim, "/Users", { method: "DELETE", headers })).status).toBe(405);
});

test("a host's extra user fields reach its hooks", async () => {
	type Linked = ScimUser & { subject: string };
	const seen = vi.fn();
	const memory = createMemoryAdapter<string>();
	const linked = (user: ScimUser): Linked => ({ ...user, subject: `sub-${user.userName}` });
	const withSubject = (store: ScimStore): ScimStore<Linked> => ({
		...store,
		user: async (id) => {
			const user = await store.user(id);
			return user && linked(user);
		},
		users: async (filter, offset, limit) => {
			const page = await store.users(filter, offset, limit);
			return { ...page, items: page.items.map(linked) };
		},
		createUser: async (fields) => linked(await store.createUser(fields)),
		replaceUser: async (id, fields) => {
			const user = await store.replaceUser(id, fields);
			return user && linked(user);
		},
		deleteUser: async (id) => {
			const user = await store.deleteUser(id);
			return user && linked(user);
		},
	});
	const scim = createScim<string, Linked>({
		adapter: createScimAdapter<string, Linked>({
			read: (connection) => withSubject(memory.read(connection)),
			transaction: (connection, fn) => memory.transaction(connection, (store, tx) => fn(withSubject(store), tx)),
		}),
		authenticate: async () => "acme",
		onUserDeprovisioned: async (user) => seen(user.subject),
	});
	const user = await scim.forConnection("acme").users.create({ userName: "a" });
	await scim.forConnection("acme").users.deactivate(user.id);
	expect(seen).toHaveBeenCalledWith("sub-a");
});
