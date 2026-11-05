import { GROUP, MAX_RESULTS, USER } from "./protocol.js";
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
		schemas: [USER],
		id: u.id,
		...(u.externalId ? { externalId: u.externalId } : {}),
		userName: u.userName,
		...(u.displayName ? { displayName: u.displayName } : {}),
		...(u.name ? { name: u.name } : {}),
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
	multiValued?: boolean;
	required?: boolean;
	mutability?: "readWrite" | "readOnly";
	uniqueness?: "none" | "server";
	referenceTypes?: string[];
	subAttributes?: Attribute[];
};
const attribute = (a: Attribute): Attribute & { caseExact: boolean; returned: string } => ({
	multiValued: false,
	required: false,
	mutability: "readWrite",
	returned: "default",
	uniqueness: "none",
	caseExact: false,
	...a,
	...(a.subAttributes ? { subAttributes: a.subAttributes.map(attribute) } : {}),
});

/** The attributes this package supports (RFC 7643 §7), not the whole core schema. */
const SCHEMAS = [
	{
		id: USER,
		name: "User",
		description: "A person provisioned by the identity provider",
		attributes: [
			{ name: "userName", type: "string", required: true, uniqueness: "server" },
			{ name: "displayName", type: "string" },
			{
				name: "name",
				type: "complex",
				subAttributes: [
					{ name: "formatted", type: "string" },
					{ name: "givenName", type: "string" },
					{ name: "familyName", type: "string" },
				],
			},
			{ name: "active", type: "boolean" },
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
					{ name: "value", type: "string" },
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
		{ id: "User", name: "User", endpoint: "/Users", schema: USER },
		{ id: "Group", name: "Group", endpoint: "/Groups", schema: GROUP },
	].map((r) => ({
		schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
		...r,
		meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/${r.id}` },
	}));
}
