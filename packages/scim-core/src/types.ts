/** RFC 7643 §4.1.1 `name`, without honorifics. */
export type ScimName = {
	formatted?: string;
	givenName?: string;
	familyName?: string;
};

export type ScimUserFields = {
	userName: string;
	/** The identifier the provider assigned. It is not an OIDC subject unless the host links them. */
	externalId: string | null;
	displayName: string | null;
	name: ScimName | null;
	active: boolean;
};

type Stored = {
	id: string;
	version: number;
	/** Epoch milliseconds. */
	createdAt: number;
	/** Epoch milliseconds. */
	updatedAt: number;
};

export type ScimUser = ScimUserFields & Stored;

export type ScimGroupFields = {
	displayName: string;
	externalId: string | null;
	memberIds: string[];
};

export type ScimGroup = Stored & {
	displayName: string;
	externalId: string | null;
	members: { id: string; userName: string }[];
};

export type ScimPage<T> = { total: number; items: T[] };

/** One change to a group. A PATCH applies these in order (RFC 7644 §3.5.2). */
export type ScimGroupChange =
	| { kind: "rename"; displayName: string }
	| { kind: "add"; ids: string[] }
	| { kind: "remove"; ids: string[] }
	| { kind: "replace"; ids: string[] };
