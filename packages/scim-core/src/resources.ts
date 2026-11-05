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
