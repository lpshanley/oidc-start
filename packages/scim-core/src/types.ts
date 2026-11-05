/** RFC 7643 §4.1.1 `name`. */
export type ScimName = {
	formatted?: string;
	familyName?: string;
	givenName?: string;
	middleName?: string;
	honorificPrefix?: string;
	honorificSuffix?: string;
};

/** One address from `emails` (RFC 7643 §4.1.2). */
export type ScimEmail = {
	value: string;
	type?: string;
	primary?: boolean;
	display?: string;
};

/**
 * The other attributes a provider sent, keyed as SCIM names them: `title`,
 * `phoneNumbers`, and the enterprise extension under its URN. Store this as
 * JSON and hand it back unchanged. It never holds a password.
 */
export type ScimAttributes = Record<string, unknown>;

export type ScimUserFields = {
	userName: string;
	/** The identifier the provider assigned. It is not an OIDC subject unless the host links them. */
	externalId: string | null;
	displayName: string | null;
	name: ScimName | null;
	emails: ScimEmail[];
	attributes: ScimAttributes;
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
	| { kind: "externalId"; externalId: string | null }
	| { kind: "add"; ids: string[] }
	| { kind: "remove"; ids: string[] }
	| { kind: "replace"; ids: string[] };
