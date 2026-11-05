import { ENTERPRISE, GROUP, MAX_RESULTS, USER } from "./protocol.js";
import type { ScimGroup, ScimUser } from "./types.js";

const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

export const listResponse = (resources: unknown[], total: number, startIndex: number) => ({
	schemas: [LIST],
	totalResults: total,
	startIndex,
	itemsPerPage: resources.length,
	Resources: resources,
});

const meta = (
	resourceType: string,
	r: { createdAt: number; updatedAt: number; version: number },
	location: string,
) => ({
	resourceType,
	created: new Date(r.createdAt).toISOString(),
	lastModified: new Date(r.updatedAt).toISOString(),
	version: `W/"${r.version}"`,
	location,
});

export function toUser(u: ScimUser, base: string) {
	return {
		schemas: ENTERPRISE in u.attributes ? [USER, ENTERPRISE] : [USER],
		id: u.id,
		...(u.externalId ? { externalId: u.externalId } : {}),
		userName: u.userName,
		...(u.displayName ? { displayName: u.displayName } : {}),
		...(u.name ? { name: u.name } : {}),
		...(u.emails.length ? { emails: u.emails } : {}),
		...u.attributes,
		active: u.active,
		meta: meta("User", u, `${base}/Users/${u.id}`),
	};
}

export function toGroup(g: ScimGroup, base: string) {
	return {
		schemas: [GROUP],
		id: g.id,
		...(g.externalId ? { externalId: g.externalId } : {}),
		displayName: g.displayName,
		members: g.members.map((m) => ({
			value: m.id,
			display: m.userName,
			$ref: `${base}/Users/${m.id}`,
		})),
		meta: meta("Group", g, `${base}/Groups/${g.id}`),
	};
}

/** An attribute name as a lowercase path. A core schema's URN prefix is optional (RFC 7644 §3.10). */
function selector(name: string) {
	const lower = name.trim().toLowerCase();
	for (const urn of [USER, GROUP]) {
		const prefix = `${urn.toLowerCase()}:`;
		if (lower.startsWith(prefix)) return lower.slice(prefix.length).split(".");
	}
	if (!lower.startsWith("urn:")) return lower.split(".");
	const split = lower.lastIndexOf(":");
	return [lower.slice(0, split), ...lower.slice(split + 1).split(".")];
}
const selectors = (list: string | null) => (list ?? "").split(",").filter((s) => s.trim()).map(selector);

const ALWAYS = new Set(["schemas", "id"]);
const startsWith = (path: string[], start: string[]) => start.every((part, i) => path[i] === part);

/** Keeps a value's `keep`-listed paths, or drops its `drop`-listed ones. */
function select(value: unknown, at: string[], keep: string[][] | null, drop: string[][]): unknown {
	if (Array.isArray(value)) return value.map((item) => select(item, at, keep, drop));
	if (typeof value !== "object" || value === null) return value;
	const entries = Object.entries(value).flatMap(([key, child]): [string, unknown][] => {
		const path = [...at, key.toLowerCase()];
		if (path.length === 1 && ALWAYS.has(path[0])) return [[key, child]];
		if (drop.some((d) => startsWith(path, d))) return [];
		if (keep && !keep.some((k) => startsWith(path, k) || startsWith(k, path))) return [];
		return [[key, select(child, path, keep?.some((k) => startsWith(path, k)) ? null : keep, drop)]];
	});
	return Object.fromEntries(entries);
}

/** Applies `attributes` and `excludedAttributes` to a resource (RFC 7644 §3.9). */
export function project<T>(resource: T, params: URLSearchParams) {
	const keep = selectors(params.get("attributes"));
	const drop = selectors(params.get("excludedAttributes"));
	if (!keep.length && !drop.length) return resource;
	return select(resource, [], keep.length ? keep : null, drop) as Partial<T>;
}

export function serviceProviderConfig(documentationUri?: string) {
	return {
		schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
		...(documentationUri ? { documentationUri } : {}),
		patch: { supported: true },
		bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
		filter: { supported: true, maxResults: MAX_RESULTS },
		changePassword: { supported: false },
		sort: { supported: false },
		etag: { supported: false },
		authenticationSchemes: [
			{
				type: "oauthbearertoken",
				name: "Bearer token",
				description: "A token issued by the application",
				primary: true,
			},
		],
	};
}

type Attribute = {
	name: string;
	type: "string" | "boolean" | "complex" | "reference";
	description?: string;
	multiValued?: boolean;
	required?: boolean;
	mutability?: "readWrite" | "readOnly";
	uniqueness?: "none" | "server";
	referenceTypes?: string[];
	subAttributes?: Attribute[];
};
const words = (name: string) => {
	const spaced = name.replace(/^\$/, "").replace(/([A-Z])/g, " $1").toLowerCase();
	return spaced[0].toUpperCase() + spaced.slice(1);
};
const attribute = (a: Attribute): Attribute & { caseExact: boolean; returned: string } => ({
	description: words(a.name),
	multiValued: false,
	required: false,
	mutability: "readWrite",
	returned: "default",
	uniqueness: "none",
	caseExact: false,
	...a,
	...(a.subAttributes ? { subAttributes: a.subAttributes.map(attribute) } : {}),
});
const text = (name: string): Attribute => ({ name, type: "string" });
const entry = ["value", "display", "type"].map(text).concat({ name: "primary", type: "boolean" });
const list = (name: string, ...extra: Attribute[]): Attribute => ({
	name,
	type: "complex",
	multiValued: true,
	subAttributes: [...entry, ...extra],
});

/** The attributes this package keeps (RFC 7643 §7), which is the core schema without password and groups. */
const SCHEMAS = [
	{
		id: USER,
		name: "User",
		description: "A person provisioned by the identity provider",
		attributes: [
			{ name: "userName", type: "string", required: true, uniqueness: "server" },
			text("displayName"),
			{
				name: "name",
				type: "complex",
				subAttributes: ["formatted", "familyName", "givenName", "middleName", "honorificPrefix", "honorificSuffix"].map(text),
			},
			...["nickName", "profileUrl", "title", "userType", "preferredLanguage", "locale", "timezone"].map(text),
			{ name: "active", type: "boolean" },
			list("emails"),
			list("phoneNumbers"),
			list("ims"),
			list("photos"),
			list("addresses", ...["formatted", "streetAddress", "locality", "region", "postalCode", "country"].map(text)),
			list("entitlements"),
			list("roles"),
			list("x509Certificates"),
		] satisfies Attribute[],
	},
	{
		id: ENTERPRISE,
		name: "EnterpriseUser",
		description: "Enterprise attributes of a user",
		attributes: [
			...["employeeNumber", "costCenter", "organization", "division", "department"].map(text),
			{ name: "manager", type: "complex", subAttributes: ["value", "displayName"].map(text) },
		] satisfies Attribute[],
	},
	{
		id: GROUP,
		name: "Group",
		description: "A group of provisioned people",
		attributes: [
			{ name: "displayName", type: "string", required: true, uniqueness: "server" },
			{
				name: "members",
				type: "complex",
				multiValued: true,
				subAttributes: [
					text("value"),
					{ name: "$ref", type: "reference", referenceTypes: ["User"] },
					{ name: "display", type: "string", mutability: "readOnly" },
				],
			},
		] satisfies Attribute[],
	},
];

export function schemas(base: string) {
	return SCHEMAS.map((s) => ({
		schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
		...s,
		attributes: s.attributes.map(attribute),
		meta: { resourceType: "Schema", location: `${base}/Schemas/${s.id}` },
	}));
}

export function resourceTypes(base: string) {
	return [
		{
			id: "User",
			name: "User",
			description: "A provisioned person",
			endpoint: "/Users",
			schema: USER,
			schemaExtensions: [{ schema: ENTERPRISE, required: false }],
		},
		{ id: "Group", name: "Group", description: "A group of people", endpoint: "/Groups", schema: GROUP },
	].map((r) => ({
		schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
		...r,
		meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/${r.id}` },
	}));
}
