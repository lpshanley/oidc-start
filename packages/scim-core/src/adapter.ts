import type { ScimGroup, ScimGroupFields, ScimPage, ScimUser, ScimUserFields } from "./types.js";

/**
 * Storage for one connection. Inside a transaction, `user` and `group` should
 * lock the row, because a write is based on what they return.
 *
 * Absent resources come back as undefined or false. A write that would
 * duplicate a live userName, externalId or group name throws ScimConflictError,
 * and member changes naming an unknown user throw ScimError 400 invalidValue.
 * Adding a member twice and removing an absent member are no-ops.
 */
export interface ScimStore<TUser extends ScimUser = ScimUser> {
	user(id: string): Promise<TUser | undefined>;
	/** `userName` matches case-insensitively (RFC 7643 §4.1.1). Order must be stable across pages. */
	users(filter: { userName?: string; externalId?: string }, offset: number, limit: number): Promise<ScimPage<TUser>>;
	createUser(fields: ScimUserFields): Promise<TUser>;
	replaceUser(id: string, fields: ScimUserFields): Promise<TUser | undefined>;
	/** Also removes the user from every group. */
	deleteUser(id: string): Promise<TUser | undefined>;
	group(id: string): Promise<ScimGroup | undefined>;
	groups(filter: { displayName?: string; externalId?: string }, offset: number, limit: number): Promise<ScimPage<ScimGroup>>;
	createGroup(fields: ScimGroupFields): Promise<string>;
	/** An undefined externalId keeps the current value. */
	renameGroup(id: string, displayName: string, externalId?: string | null): Promise<boolean>;
	setMembers(groupId: string, userIds: string[]): Promise<void>;
	addMembers(groupId: string, userIds: string[]): Promise<void>;
	removeMembers(groupId: string, userIds: string[]): Promise<void>;
	deleteGroup(id: string): Promise<boolean>;
}

/**
 * How the package reaches the host's storage. A connection is whatever the
 * host's `authenticate` returns, usually one customer's directory. Stores must
 * only see that connection's rows. `TTransaction` is the host's handle, passed
 * to hooks so their writes commit or roll back with the change.
 */
export interface ScimAdapter<TConnection, TUser extends ScimUser = ScimUser, TTransaction = undefined> {
	read(connection: TConnection): ScimStore<TUser>;
	transaction<T>(
		connection: TConnection,
		fn: (store: ScimStore<TUser>, tx: TTransaction) => Promise<T>,
	): Promise<T>;
}

/** Declares an adapter and infers its types for `createScim`. */
export function createScimAdapter<TConnection, TUser extends ScimUser = ScimUser, TTransaction = undefined>(
	adapter: ScimAdapter<TConnection, TUser, TTransaction>,
) {
	return adapter;
}
