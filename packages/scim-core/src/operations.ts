import { isDeepStrictEqual } from "node:util";
import type { ScimAdapter, ScimStore } from "./adapter.js";
import { notFound, ScimError } from "./errors.js";
import { patchUser, parseUser, replaceUser } from "./protocol.js";
import type { ScimGroup, ScimGroupChange, ScimGroupFields, ScimGroupFilter, ScimUser, ScimUserFields, ScimUserFilter } from "./types.js";

type Details = Record<string, unknown>;
type GroupSummary = { id: string; displayName: string };

/** Present when the stored externalId changed, with the value it replaced. Relink on this if you link by externalId. */
type ExternalIdChange = { previousExternalId?: string | null };

/** What a committed request changed. */
export type ScimChange<TUser extends ScimUser = ScimUser> =
	| { type: "user.created"; user: TUser }
	| ({ type: "user.updated"; user: TUser } & ExternalIdChange)
	/** `externalIdConflict`: with a fixed externalId, the request sent a different one, which was not stored. */
	| ({ type: "user.deactivated"; user: TUser; details?: Details; externalIdConflict?: true } & ExternalIdChange)
	| { type: "user.deleted"; user: TUser; details?: Details }
	| { type: "group.created"; group: GroupSummary; members: number }
	| { type: "group.replaced"; group: GroupSummary; members: number }
	| { type: "group.patched"; group: GroupSummary; added: number; removed: number; replaced: boolean }
	| { type: "group.deleted"; group: GroupSummary };

export type ScimHooks<TConnection, TUser extends ScimUser, TTransaction> = {
	/**
	 * Runs inside the transaction when a user is deactivated or deleted, so a
	 * failure rolls the change back. End access and delete the user's data
	 * here. What it returns reaches `onChange` and `onCommitted` as `details`.
	 */
	onUserDeprovisioned?(
		user: TUser,
		context: { connection: TConnection; tx: TTransaction; reason: "deactivated" | "deleted" },
	): Promise<Details | void>;
	/** Runs inside the transaction for every change, for example to write an audit row. */
	onChange?(change: ScimChange<TUser>, context: { connection: TConnection; tx: TTransaction }): Promise<void>;
	/** Runs after commit, for example to clear a cache. A failure here cannot undo the change. */
	onCommitted?(change: ScimChange<TUser>, context: { connection: TConnection }): Promise<void> | void;
};

type Options<TConnection, TUser extends ScimUser, TTransaction> = ScimHooks<TConnection, TUser, TTransaction> & {
	adapter: ScimAdapter<TConnection, TUser, TTransaction>;
	externalId?: "mutable" | "fixed";
	/** Reports a hook that failed after commit. */
	afterCommitFailed(error: unknown): void;
};

const fieldsOf = ({ userName, externalId, displayName, name, emails, attributes, active }: ScimUserFields): ScimUserFields => ({
	userName,
	externalId,
	displayName,
	name,
	emails,
	attributes,
	active,
});
const summary = (g: { id: string; displayName: string }): GroupSummary => ({ id: g.id, displayName: g.displayName });

/** Whether a group PATCH would leave the group as it is. */
function unchanged(group: ScimGroup, patch: ScimGroupChange[]) {
	const before = group.members.map((m) => m.id);
	const members = new Set(before);
	let { displayName, externalId } = group;
	for (const change of patch) {
		if (change.kind === "rename") displayName = change.displayName;
		else if (change.kind === "externalId") externalId = change.externalId;
		else if (change.kind === "add") for (const id of change.ids) members.add(id);
		else if (change.kind === "remove") for (const id of change.ids) members.delete(id);
		else {
			members.clear();
			for (const id of change.ids) members.add(id);
		}
	}
	return (
		displayName === group.displayName &&
		externalId === group.externalId &&
		members.size === before.length &&
		before.every((id) => members.has(id))
	);
}

/**
 * Every change runs in one transaction with its hooks. HTTP requests and direct
 * calls share this path, so both end access the same way.
 */
export function createOperations<TConnection, TUser extends ScimUser, TTransaction>(
	options: Options<TConnection, TUser, TTransaction>,
	connection: TConnection,
) {
	const { adapter, onUserDeprovisioned, onChange, onCommitted } = options;
	type Record = (change: ScimChange<TUser>) => Promise<void>;

	async function commit<T>(fn: (store: ScimStore<TUser>, tx: TTransaction, record: Record) => Promise<T>) {
		const changes: ScimChange<TUser>[] = [];
		const result = await adapter.transaction(connection, (store, tx) =>
			fn(store, tx, async (change) => {
				await onChange?.(change, { connection, tx });
				changes.push(change);
			}),
		);
		for (const change of changes) {
			try {
				await onCommitted?.(change, { connection });
			} catch (error) {
				options.afterCommitFailed(error);
			}
		}
		return result;
	}

	const deprovision = async (user: TUser, tx: TTransaction, reason: "deactivated" | "deleted") =>
		(await onUserDeprovisioned?.(user, { connection, tx, reason })) ?? undefined;

	const write = (id: string, next: (current: ScimUserFields) => ScimUserFields) =>
		commit(async (store, tx, record) => {
			const current = await store.user(id);
			if (!current) throw notFound();
			const fields = next(fieldsOf(current));
			const conflict =
				options.externalId === "fixed" && current.externalId !== null && fields.externalId !== current.externalId;
			const deactivating = current.active && !fields.active;
			// Ending access matters more than a clean request, so a deactivation
			// still goes through and the stored externalId stays as it was.
			if (conflict && !deactivating) throw new ScimError(400, "mutability", "externalId cannot change");
			const stored = conflict ? { ...fields, externalId: current.externalId } : fields;
			// An unchanged resource keeps its lastModified (RFC 7644 §3.5.2.1).
			if (isDeepStrictEqual(stored, fieldsOf(current))) return current;
			const user = await store.replaceUser(id, stored);
			if (!user) throw notFound();
			const relinked = stored.externalId === current.externalId ? {} : { previousExternalId: current.externalId };
			if (deactivating) {
				const details = await deprovision(user, tx, "deactivated");
				await record({
					type: "user.deactivated",
					user,
					...(details ? { details } : {}),
					...(conflict ? { externalIdConflict: true as const } : {}),
					...relinked,
				});
			} else await record({ type: "user.updated", user, ...relinked });
			return user;
		});

	const group = async (id: string) => (await adapter.read(connection).group(id)) ?? Promise.reject(notFound());

	return {
		users: {
			get: async (id: string) => (await adapter.read(connection).user(id)) ?? Promise.reject(notFound()),
			list: (filter: ScimUserFilter, offset: number, limit: number) =>
				adapter.read(connection).users(filter, offset, limit),
			create: (body: unknown) => {
				const fields = parseUser(body);
				return commit(async (store, _tx, record) => {
					const user = await store.createUser(fields);
					await record({ type: "user.created", user });
					return user;
				});
			},
			replace: (id: string, body: unknown) => write(id, (current) => replaceUser(current, body)),
			patch: (id: string, body: unknown) => write(id, (current) => patchUser(current, body)),
			/** An offboarding the application started. It takes the same path as a provider's request. */
			deactivate: (id: string) => write(id, (current) => ({ ...current, active: false })),
			delete: (id: string) =>
				commit(async (store, tx, record) => {
					const user = await store.deleteUser(id);
					if (!user) throw notFound();
					const details = await deprovision(user, tx, "deleted");
					await record({ type: "user.deleted", user, ...(details ? { details } : {}) });
				}),
		},
		groups: {
			get: group,
			list: (filter: ScimGroupFilter, offset: number, limit: number) =>
				adapter.read(connection).groups(filter, offset, limit),
			create: async (fields: ScimGroupFields): Promise<ScimGroup> => {
				const id = await commit(async (store, _tx, record) => {
					const id = await store.createGroup(fields);
					await record({
						type: "group.created",
						group: { id, displayName: fields.displayName },
						members: fields.memberIds.length,
					});
					return id;
				});
				return group(id);
			},
			replace: async (id: string, fields: ScimGroupFields): Promise<ScimGroup> => {
				await commit(async (store, _tx, record) => {
					const current = await store.group(id);
					if (!current) throw notFound();
					await store.renameGroup(id, fields.displayName, fields.externalId ?? current.externalId);
					await store.setMembers(id, fields.memberIds);
					await record({
						type: "group.replaced",
						group: { id, displayName: fields.displayName },
						members: fields.memberIds.length,
					});
				});
				return group(id);
			},
			patch: async (id: string, patch: ScimGroupChange[]): Promise<ScimGroup> => {
				await commit(async (store, _tx, record) => {
					const current = await store.group(id);
					if (!current) throw notFound();
					if (unchanged(current, patch)) return;
					let displayName = current.displayName;
					const counts = { added: 0, removed: 0, replaced: false };
					for (const change of patch) {
						if (change.kind === "rename") {
							displayName = change.displayName;
							await store.renameGroup(id, displayName);
						} else if (change.kind === "externalId") {
							await store.renameGroup(id, displayName, change.externalId);
						} else if (change.kind === "add") {
							counts.added += change.ids.length;
							await store.addMembers(id, change.ids);
						} else if (change.kind === "remove") {
							counts.removed += change.ids.length;
							await store.removeMembers(id, change.ids);
						} else {
							counts.replaced = true;
							await store.setMembers(id, change.ids);
						}
					}
					await record({ type: "group.patched", group: { id, displayName }, ...counts });
				});
				return group(id);
			},
			delete: (id: string) =>
				commit(async (store, _tx, record) => {
					const current = await store.group(id);
					if (!current || !(await store.deleteGroup(id))) throw notFound();
					await record({ type: "group.deleted", group: summary(current) });
				}),
		},
	};
}
