import { randomUUID } from "node:crypto";
import { createScimAdapter, type ScimStore } from "../adapter.js";
import { ScimConflictError, ScimError } from "../errors.js";
import type { ScimGroup, ScimUser } from "../types.js";

type GroupRow = Omit<ScimGroup, "members"> & { memberIds: string[] };
type State = { users: Map<string, ScimUser>; groups: Map<string, GroupRow> };

function storeOf(state: State, now: () => number): ScimStore {
	const lower = (s: string) => s.toLowerCase();
	const copy = <T>(value: T): T => structuredClone(value);
	const page = <T>(items: T[], offset: number, limit: number) => ({
		total: items.length,
		items: items.slice(offset, offset + limit),
	});
	const group = (row: GroupRow): ScimGroup => {
		const { memberIds, ...rest } = row;
		return {
			...rest,
			members: memberIds.map((id) => ({ id, userName: state.users.get(id)!.userName })),
		};
	};
	const unique = (fields: { userName: string; externalId: string | null }, self?: string) => {
		for (const u of state.users.values()) {
			if (u.id === self) continue;
			if (lower(u.userName) === lower(fields.userName)) throw new ScimConflictError();
			if (fields.externalId !== null && u.externalId === fields.externalId) throw new ScimConflictError();
		}
	};
	const uniqueGroup = (displayName: string, self?: string) => {
		for (const g of state.groups.values())
			if (g.id !== self && lower(g.displayName) === lower(displayName)) throw new ScimConflictError();
	};
	const known = (ids: string[]) => {
		for (const id of ids)
			if (!state.users.has(id)) throw new ScimError(400, "invalidValue", `Unknown member ${id}`);
	};
	const touched = (row: GroupRow) => {
		row.version += 1;
		row.updatedAt = now();
	};
	return {
		async user(id) {
			return copy(state.users.get(id));
		},
		async users(f, offset, limit) {
			const items = [...state.users.values()].filter(
				(u) =>
					(f.id === undefined || u.id === f.id) &&
					(f.userName === undefined || lower(u.userName) === lower(f.userName)) &&
					(f.externalId === undefined || u.externalId === f.externalId) &&
					(f.email === undefined ||
						u.emails.some(
							(e) =>
								lower(e.value) === lower(f.email!) &&
								(f.emailType === undefined || lower(e.type ?? "") === lower(f.emailType)),
						)),
			);
			return copy(page(items, offset, limit));
		},
		async createUser(fields) {
			unique(fields);
			const at = now();
			const user = { ...copy(fields), id: randomUUID(), version: 1, createdAt: at, updatedAt: at };
			state.users.set(user.id, user);
			return copy(user);
		},
		async replaceUser(id, fields) {
			const current = state.users.get(id);
			if (!current) return undefined;
			unique(fields, id);
			const user = { ...current, ...copy(fields), version: current.version + 1, updatedAt: now() };
			state.users.set(id, user);
			return copy(user);
		},
		async deleteUser(id) {
			const user = state.users.get(id);
			if (!user) return undefined;
			state.users.delete(id);
			for (const g of state.groups.values()) g.memberIds = g.memberIds.filter((m) => m !== id);
			return copy(user);
		},
		async group(id) {
			const row = state.groups.get(id);
			return row && group(copy(row));
		},
		async groups(f, offset, limit) {
			const items = [...state.groups.values()].filter(
				(g) =>
					(f.id === undefined || g.id === f.id) &&
					(f.displayName === undefined || lower(g.displayName) === lower(f.displayName)) &&
					(f.externalId === undefined || g.externalId === f.externalId),
			);
			return copy(page(items.map(group), offset, limit));
		},
		async createGroup(fields) {
			uniqueGroup(fields.displayName);
			known(fields.memberIds);
			const at = now();
			const id = randomUUID();
			state.groups.set(id, {
				id,
				displayName: fields.displayName,
				externalId: fields.externalId,
				memberIds: [...new Set(fields.memberIds)],
				version: 1,
				createdAt: at,
				updatedAt: at,
			});
			return id;
		},
		async renameGroup(id, displayName, externalId) {
			const row = state.groups.get(id);
			if (!row) return false;
			uniqueGroup(displayName, id);
			row.displayName = displayName;
			if (externalId !== undefined) row.externalId = externalId;
			touched(row);
			return true;
		},
		async setMembers(id, userIds) {
			const row = state.groups.get(id);
			if (!row) return;
			known(userIds);
			row.memberIds = [...new Set(userIds)];
			touched(row);
		},
		async addMembers(id, userIds) {
			const row = state.groups.get(id);
			if (!row) return;
			known(userIds);
			row.memberIds = [...new Set([...row.memberIds, ...userIds])];
			touched(row);
		},
		async removeMembers(id, userIds) {
			const row = state.groups.get(id);
			if (!row) return;
			row.memberIds = row.memberIds.filter((m) => !userIds.includes(m));
			touched(row);
		},
		async deleteGroup(id) {
			return state.groups.delete(id);
		},
	};
}

/**
 * A single-process adapter for trying the package and for fast tests. Each
 * connection has its own data. Transactions run one at a time per connection
 * and roll back when their function rejects; reads see committed data.
 */
export function createMemoryAdapter<TConnection = string>(
	options: { key?: (connection: TConnection) => string; now?: () => number } = {},
) {
	const key = options.key ?? ((connection: TConnection) => JSON.stringify(connection));
	const now = options.now ?? Date.now;
	const tenants = new Map<string, { state: State; tail: Promise<unknown> }>();
	const tenant = (connection: TConnection) => {
		const k = key(connection);
		let t = tenants.get(k);
		if (!t) tenants.set(k, (t = { state: { users: new Map(), groups: new Map() }, tail: Promise.resolve() }));
		return t;
	};
	return createScimAdapter<TConnection>({
		read(connection) {
			const t = tenant(connection);
			return new Proxy({} as ScimStore, {
				get: (_target, method: keyof ScimStore) => storeOf(t.state, now)[method],
			});
		},
		transaction(connection, fn) {
			const t = tenant(connection);
			const run = async () => {
				const draft = structuredClone(t.state);
				const result = await fn(storeOf(draft, now), undefined);
				t.state = draft;
				return result;
			};
			const result = t.tail.then(run, run);
			t.tail = result.catch(() => {});
			return result;
		},
	});
}
