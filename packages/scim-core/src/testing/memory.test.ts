import { expect, test } from "vitest";
import type { ScimAdapter, ScimStore } from "../adapter.js";
import { createMemoryAdapter } from "./memory.js";
import { testScimAdapter } from "./contract.js";

testScimAdapter({
	setup: async () => ({ adapter: createMemoryAdapter<string>(), connections: ["acme", "globex"] }),
	test: (name, fn) => test(name, fn),
});

/** The names of the contract checks a sabotaged adapter fails. */
async function failures(sabotage: (adapter: ScimAdapter<string>) => ScimAdapter<string>) {
	const checks: [string, () => Promise<void>][] = [];
	testScimAdapter({
		setup: async () => ({ adapter: sabotage(createMemoryAdapter<string>()), connections: ["acme", "globex"] }),
		test: (name, fn) => checks.push([name, fn]),
	});
	const failed: string[] = [];
	for (const [name, fn] of checks) await fn().catch(() => failed.push(name.replace("adapter contract: ", "")));
	return failed;
}

test("the contract catches an adapter that does not roll back", async () => {
	expect(
		await failures((adapter) => ({
			...adapter,
			transaction: async (connection, fn) => {
				// Commit each write as it happens, as a missing transaction would.
				const direct = new Proxy({} as ScimStore, {
					get: (_target, method: keyof ScimStore) => (...args: never[]) =>
						adapter.transaction(connection, (tx) => (tx[method] as (...a: never[]) => Promise<unknown>)(...args)),
				});
				return fn(direct, undefined);
			},
		})),
	).toEqual(["a failed transaction changes nothing"]);
});

test("the contract catches an adapter that shares data between connections", async () => {
	const shared = createMemoryAdapter<string>();
	expect(
		await failures(() => ({
			read: () => shared.read("one"),
			transaction: (_connection, fn) => shared.transaction("one", fn),
		})),
	).toContain("connections never see each other's data");
});

test("the contract catches an adapter that compares userName exactly", async () => {
	expect(
		await failures((adapter) => ({
			...adapter,
			transaction: (connection, fn) =>
				adapter.transaction(connection, (store, tx) =>
					fn(
						{
							...store,
							users: async (filter, offset, limit) => {
								const page = await store.users(filter, offset, limit);
								const items = page.items.filter((u) => !filter.userName || u.userName === filter.userName);
								return { total: items.length, items };
							},
						},
						tx,
					),
				),
		})),
	).toContain("finds users by userName ignoring case, and by externalId");
});

test("the contract catches an adapter that compares group names exactly", async () => {
	expect(
		await failures((adapter) => ({
			...adapter,
			transaction: (connection, fn) =>
				adapter.transaction(connection, (store, tx) =>
					fn(
						{
							...store,
							groups: async (filter, offset, limit) => {
								const page = await store.groups(filter, offset, limit);
								const items = page.items.filter((g) => !filter.displayName || g.displayName === filter.displayName);
								return { total: items.length, items };
							},
						},
						tx,
					),
				),
		})),
	).toContain("renames groups, finds them, and refuses a duplicate name");
});
