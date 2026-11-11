import assert from "node:assert/strict";
import type { ScimAdapter, ScimStore } from "../adapter.js";
import { ScimConflictError, ScimError } from "../errors.js";
import type { ScimUser, ScimUserFields } from "../types.js";

const fields = (userName: string, more: Partial<ScimUserFields> = {}): ScimUserFields => ({
	userName,
	externalId: null,
	displayName: null,
	name: null,
	emails: [],
	attributes: {},
	active: true,
	...more,
});

const rejectsWith = (promise: Promise<unknown>, expected: (error: unknown) => boolean) =>
	assert.rejects(promise, (error) => expected(error));
const conflict = (error: unknown) => error instanceof ScimConflictError;
const invalidValue = (error: unknown) =>
	error instanceof ScimError && error.status === 400 && error.scimType === "invalidValue";

/**
 * Checks an adapter against the `ScimStore` contract. `setup` returns an empty
 * adapter and two connections. Pass your test runner's `test`. Run this against
 * your real database, because only that proves transactions and constraints.
 */
export function testScimAdapter<TConnection, TUser extends ScimUser, TTransaction>(options: {
	setup(): Promise<{
		adapter: ScimAdapter<TConnection, TUser, TTransaction>;
		connections: [TConnection, TConnection];
	}>;
	test(name: string, fn: () => Promise<void>): void;
}) {
	const check = (name: string, fn: (store: ScimStore<TUser>, c: {
		adapter: ScimAdapter<TConnection, TUser, TTransaction>;
		connections: [TConnection, TConnection];
	}) => Promise<void>) =>
		options.test(`adapter contract: ${name}`, async () => {
			const context = await options.setup();
			await context.adapter.transaction(context.connections[0], (store) => fn(store, context));
		});
	const member = async (store: ScimStore<TUser>, userName: string) => (await store.createUser(fields(userName))).id;

	check("stores and returns every user field", async (store) => {
		const wanted = fields("a@x.test", {
			externalId: "ext-1",
			displayName: "Alice",
			name: { givenName: "Alice", familyName: "Example" },
			emails: [{ value: "a@x.test", type: "work", primary: true }],
			attributes: { title: "CTO", phoneNumbers: [{ type: "work", value: "1" }] },
			active: false,
		});
		const created = await store.createUser(wanted);
		assert.ok(created.id);
		assert.equal(created.version, 1);
		const { id, version, createdAt, updatedAt, ...stored } = (await store.user(created.id))!;
		assert.deepEqual({ ...wanted }, Object.fromEntries(Object.keys(wanted).map((k) => [k, stored[k as keyof typeof stored]])));
		assert.ok(id && version && createdAt && updatedAt);
		assert.equal(await store.user("missing"), undefined);
	});

	check("refuses a duplicate userName, ignoring case, and a duplicate externalId", async (store) => {
		await store.createUser(fields("a@x.test", { externalId: "ext-1" }));
		await rejectsWith(store.createUser(fields("A@X.TEST")), conflict);
		await rejectsWith(store.createUser(fields("b@x.test", { externalId: "ext-1" })), conflict);
		const other = await store.createUser(fields("c@x.test"));
		await rejectsWith(store.replaceUser(other.id, fields("a@x.test")), conflict);
		await store.createUser(fields("d@x.test"));
	});

	check("finds users by userName ignoring case, and by externalId", async (store) => {
		const a = await store.createUser(fields("a@x.test", { externalId: "ext-1" }));
		await store.createUser(fields("b@x.test"));
		assert.deepEqual((await store.users({ userName: "A@X.test" }, 0, 10)).items.map((u) => u.id), [a.id]);
		assert.deepEqual((await store.users({ externalId: "ext-1" }, 0, 10)).items.map((u) => u.id), [a.id]);
		assert.equal((await store.users({ externalId: "EXT-1" }, 0, 10)).total, 0);
	});

	check("combines user filters, and finds users by id and email", async (store) => {
		const emails = [{ value: "Work@X.test", type: "work" }, { value: "home@x.test", type: "home" }];
		const a = await store.createUser(fields("a@x.test", { externalId: "ext-1", emails }));
		await store.createUser(fields("b@x.test", { emails: [{ value: "work@x.test", type: "home" }] }));
		const ids = async (filter: Parameters<typeof store.users>[0]) => (await store.users(filter, 0, 10)).items.map((u) => u.id);
		assert.deepEqual(await ids({ id: a.id }), [a.id]);
		assert.equal((await ids({ email: "WORK@x.test" })).length, 2);
		assert.deepEqual(await ids({ email: "work@x.test", emailType: "WORK" }), [a.id]);
		assert.deepEqual(await ids({ email: "home@x.test", emailType: "work" }), []);
		assert.deepEqual(await ids({ userName: "a@x.test", externalId: "ext-1" }), [a.id]);
		assert.deepEqual(await ids({ userName: "a@x.test", externalId: "other" }), []);
	});

	check("pages users in a stable order with the full total", async (store) => {
		for (const n of [1, 2, 3, 4, 5]) await store.createUser(fields(`u${n}@x.test`));
		const seen: string[] = [];
		for (const offset of [0, 2, 4]) {
			const page = await store.users({}, offset, 2);
			assert.equal(page.total, 5);
			seen.push(...page.items.map((u) => u.id));
		}
		assert.equal(new Set(seen).size, 5);
		assert.equal((await store.users({}, 0, 0)).items.length, 0);
	});

	check("replacing a user advances its version", async (store) => {
		const user = await store.createUser(fields("a@x.test"));
		const updated = await store.replaceUser(user.id, fields("a@x.test", { active: false, displayName: "New" }));
		assert.equal(updated?.active, false);
		assert.equal(updated?.displayName, "New");
		assert.ok(updated!.version > user.version);
		assert.ok(updated!.updatedAt >= user.updatedAt);
		assert.equal(await store.replaceUser("missing", fields("b@x.test")), undefined);
	});

	check("deleting a user frees their userName and leaves their groups", async (store) => {
		const id = await member(store, "a@x.test");
		const group = await store.createGroup({ displayName: "Ops", externalId: null, memberIds: [id] });
		assert.equal((await store.deleteUser(id))?.id, id);
		assert.equal(await store.user(id), undefined);
		assert.equal(await store.deleteUser(id), undefined);
		assert.deepEqual((await store.group(group))?.members, []);
		await store.createUser(fields("a@x.test"));
	});

	check("group membership is idempotent and shows each member's userName", async (store) => {
		const [a, b] = [await member(store, "a@x.test"), await member(store, "b@x.test")];
		const group = await store.createGroup({ displayName: "Ops", externalId: "g-1", memberIds: [a] });
		const ids = async () => (await store.group(group))!.members.map((m) => m.id).sort();
		await store.addMembers(group, [a, b]);
		assert.deepEqual(await ids(), [a, b].sort());
		assert.ok((await store.group(group))!.members.some((m) => m.userName === "a@x.test"));
		await store.removeMembers(group, ["missing", a]);
		assert.deepEqual(await ids(), [b]);
		await store.setMembers(group, [a]);
		assert.deepEqual(await ids(), [a]);
		await store.setMembers(group, []);
		assert.deepEqual(await ids(), []);
	});

	check("refuses unknown members", async (store) => {
		await rejectsWith(store.createGroup({ displayName: "Bad", externalId: null, memberIds: ["missing"] }), invalidValue);
		const group = await store.createGroup({ displayName: "Ops", externalId: null, memberIds: [] });
		await rejectsWith(store.addMembers(group, ["missing"]), invalidValue);
		await rejectsWith(store.setMembers(group, ["missing"]), invalidValue);
	});

	check("renames groups, finds them, and refuses a duplicate name", async (store) => {
		const group = await store.createGroup({ displayName: "Ops", externalId: "g-1", memberIds: [] });
		assert.equal(await store.renameGroup(group, "Platform"), true);
		assert.equal((await store.group(group))?.externalId, "g-1");
		await store.renameGroup(group, "Platform", null);
		assert.equal((await store.group(group))?.externalId, null);
		assert.equal(await store.renameGroup("missing", "None"), false);
		assert.equal((await store.groups({ displayName: "Platform" }, 0, 10)).total, 1);
		assert.equal((await store.groups({ id: group }, 0, 10)).total, 1);
		assert.equal((await store.groups({ displayName: "PLATFORM" }, 0, 10)).total, 1);
		assert.equal(await store.renameGroup(group, "PLATFORM"), true);
		await store.renameGroup(group, "Platform");
		await rejectsWith(store.createGroup({ displayName: "platform", externalId: null, memberIds: [] }), conflict);
		await rejectsWith(store.createGroup({ displayName: "Platform", externalId: null, memberIds: [] }), conflict);
		assert.equal(await store.deleteGroup(group), true);
		assert.equal(await store.deleteGroup(group), false);
		assert.equal(await store.group(group), undefined);
	});

	options.test("adapter contract: a failed transaction changes nothing", async () => {
		const { adapter, connections } = await options.setup();
		await assert.rejects(
			adapter.transaction(connections[0], async (store) => {
				await store.createUser(fields("a@x.test"));
				throw new Error("rolled back");
			}),
			/rolled back/,
		);
		assert.equal((await adapter.read(connections[0]).users({}, 0, 10)).total, 0);
	});

	options.test("adapter contract: connections never see each other's data", async () => {
		const { adapter, connections } = await options.setup();
		const [one, two] = connections;
		const { user, group } = await adapter.transaction(one, async (store) => ({
			user: await store.createUser(fields("a@x.test", { externalId: "ext-1" })),
			group: await store.createGroup({ displayName: "Ops", externalId: null, memberIds: [] }),
		}));
		const other = adapter.read(two);
		assert.equal(await other.user(user.id), undefined);
		assert.equal(await other.group(group), undefined);
		assert.equal((await other.users({}, 0, 10)).total, 0);
		await adapter.transaction(two, async (store) => {
			assert.equal(await store.replaceUser(user.id, fields("x@x.test")), undefined);
			assert.equal(await store.deleteUser(user.id), undefined);
			await store.createUser(fields("a@x.test", { externalId: "ext-1" }));
		});
	});
}
