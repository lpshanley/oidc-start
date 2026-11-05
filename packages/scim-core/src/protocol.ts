import { z } from "zod";
import { ScimError } from "./errors.js";
import type { ScimGroupChange, ScimGroupFields, ScimName, ScimUserFields } from "./types.js";

export const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const MAX_RESULTS = 200;

const invalid = (detail: string) => new ScimError(400, "invalidValue", detail);
const noTarget = () => new ScimError(400, "noTarget", "remove needs a path");

/** Reads a required value, reporting the schema's first problem as a SCIM error. */
function read<T>(schema: z.ZodType<T>, value: unknown) {
	const result = schema.safeParse(value);
	if (!result.success) throw invalid(result.error.issues[0].message);
	return result.data;
}

const text = z.string().max(256).trim().min(1).optional().catch(undefined);
const required = (attribute: string) => {
	const error = `${attribute} must be a string`;
	return z.string({ error }).max(256, error).trim().min(1, error);
};
const userName = required("userName");
const externalId = required("externalId");
const displayName = required("displayName");
/** Some providers send booleans as strings. */
const active = z.union([z.boolean(), z.stringbool({ truthy: ["true"], falsy: ["false"] })], {
	error: "active must be a boolean",
});
const jsonObject = z.looseObject({}, { error: "Expected a JSON object" });

const userResource = z.object(
	{
		userName,
		externalId: text,
		displayName: text,
		name: z.unknown().optional(),
		active: active.optional(),
	},
	{ error: "Expected a JSON object" },
);
const groupResource = z.object(
	{ displayName, externalId: text, members: z.unknown().optional() },
	{ error: "Expected a JSON object" },
);

const NAME_PARTS = ["formatted", "givenName", "familyName"] as const;
const nameObject = z.looseObject({}).catch({});
function nameOf(value: unknown, current: ScimName | null = null): ScimName | null {
	const given = nameObject.parse(value);
	const next: ScimName = { ...current };
	for (const part of NAME_PARTS) {
		const key = Object.keys(given).find((k) => k.toLowerCase() === part.toLowerCase());
		if (key) next[part] = text.parse(given[key]);
		if (next[part] === undefined) delete next[part];
	}
	return Object.keys(next).length ? next : null;
}

/** A full User resource from POST or PUT. */
export function parseUser(body: unknown): ScimUserFields {
	const user = read(userResource, body);
	return {
		userName: user.userName,
		externalId: user.externalId ?? null,
		displayName: user.displayName ?? null,
		name: nameOf(user.name),
		active: user.active ?? true,
	};
}

/**
 * A PUT. Omitting `active` or `externalId` keeps the current value, so a
 * provider's sparse update can neither reactivate a user nor break a link
 * the host built on `externalId` (RFC 7644 §3.5.1 allows this choice).
 */
export function replaceUser(current: ScimUserFields, body: unknown): ScimUserFields {
	const fields = parseUser(body);
	return {
		...fields,
		externalId: fields.externalId ?? current.externalId,
		active: read(userResource, body).active ?? current.active,
	};
}

const operation = z.looseObject(
	{ op: z.unknown().optional(), path: z.unknown().optional(), value: z.unknown().optional() },
	{ error: "Each operation must be an object" },
);
type Op = z.infer<typeof operation>;
const patchRequest = z.object(
	{
		Operations: z.array(operation, { error: "Operations are required" }).min(1, "Operations are required"),
		schemas: z
			.unknown()
			.optional()
			.refine((v) => !Array.isArray(v) || v.includes(PATCH), "Expected the PatchOp schema"),
	},
	{ error: "Expected a JSON object" },
);
const operations = (body: unknown): Op[] => read(patchRequest, body).Operations;
const opName = (o: Op) => String(o.op ?? "").toLowerCase();
/** A path may carry the schema it belongs to (RFC 7644 §3.10). */
const attributePath = (path: unknown) => {
	const p = String(path ?? "").toLowerCase();
	const prefix = `${USER.toLowerCase()}:`;
	return p.startsWith(prefix) ? p.slice(prefix.length) : p;
};

/**
 * Applies a PATCH to a user, in order: replace or add of `active`, `userName`,
 * `externalId`, `displayName`, `name` and `name.*`, with or without a path, and
 * remove of `displayName`, `name` and `name.*`. Other attributes are accepted
 * and not stored.
 */
export function patchUser(current: ScimUserFields, body: unknown): ScimUserFields {
	const next = { ...current };
	const set = (path: string, value: unknown) => {
		const p = attributePath(path);
		if (p === "active") {
			next.active = read(active.optional(), value) ?? next.active;
		} else if (p === "username") {
			next.userName = read(userName, value);
		} else if (p === "externalid") {
			next.externalId = read(externalId, value);
		} else if (p === "displayname") {
			next.displayName = text.parse(value) ?? null;
		} else if (p === "name") {
			next.name = nameOf(value, next.name);
		} else if (p.startsWith("name.")) {
			const part = NAME_PARTS.find((n) => n.toLowerCase() === p.slice("name.".length));
			if (part) next.name = nameOf({ [part]: value }, next.name);
		}
	};
	for (const o of operations(body)) {
		const op = opName(o);
		if (op === "remove") {
			const path = attributePath(o.path);
			if (!path) throw noTarget();
			if (["active", "username", "externalid"].includes(path))
				throw new ScimError(400, "mutability", `Cannot remove ${path}`);
			if (path === "displayname") next.displayName = null;
			else if (path === "name") next.name = null;
			else if (path.startsWith("name.")) set(path, undefined);
			continue;
		}
		if (op !== "replace" && op !== "add") throw invalid(`Unsupported op ${String(o.op)}`);
		if (typeof o.path === "string" && o.path) set(o.path, o.value);
		else for (const [k, v] of Object.entries(read(jsonObject, o.value))) set(k, v);
	}
	return next;
}

const memberReference = z.looseObject({ value: z.string() });
/** Skips entries that are not member references, as providers may send extra ones. */
const memberIds = (v: unknown) =>
	(Array.isArray(v) ? v : [v]).flatMap((m) => {
		const member = memberReference.safeParse(m);
		return member.success ? [member.data.value] : [];
	});

export function parseGroup(body: unknown): ScimGroupFields {
	const group = read(groupResource, body);
	return {
		displayName: group.displayName,
		externalId: group.externalId ?? null,
		memberIds: memberIds(group.members ?? []),
	};
}

/** Group PATCH: add or remove members (also `members[value eq "id"]`), replace displayName or members. */
export function patchGroup(body: unknown): ScimGroupChange[] {
	const patch: ScimGroupChange[] = [];
	for (const o of operations(body)) {
		const op = opName(o);
		const path = String(o.path ?? "");
		const filtered = /^members\[value eq "([^"]+)"\]$/i.exec(path);
		if (op === "remove" && !path) throw noTarget();
		if (op === "add" && /^members$/i.test(path)) patch.push({ kind: "add", ids: memberIds(o.value) });
		else if (op === "remove" && filtered) patch.push({ kind: "remove", ids: [filtered[1]] });
		else if (op === "remove" && /^members$/i.test(path))
			patch.push(
				o.value === undefined ? { kind: "replace", ids: [] } : { kind: "remove", ids: memberIds(o.value) },
			);
		else if (op === "replace" && /^members$/i.test(path)) patch.push({ kind: "replace", ids: memberIds(o.value) });
		else if ((op === "replace" || op === "add") && /^displayName$/i.test(path))
			patch.push({ kind: "rename", displayName: read(displayName, o.value) });
		else if ((op === "replace" || op === "add") && !path) {
			const v = read(jsonObject, o.value);
			if (v.displayName !== undefined)
				patch.push({ kind: "rename", displayName: read(displayName, v.displayName) });
			if (v.members !== undefined)
				patch.push({ kind: op === "add" ? "add" : "replace", ids: memberIds(v.members) });
		} else throw invalid(`Unsupported group operation ${op} ${path}`);
	}
	return patch;
}

/** `attr eq "value"`, the filter identity providers send to find a resource. */
export function parseFilter<A extends string>(filter: string | null, allowed: readonly A[]): Partial<Record<A, string>> {
	if (!filter) return {};
	const m = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
	const attr = m && allowed.find((a) => a.toLowerCase() === m[1].toLowerCase());
	if (!m || !attr) throw new ScimError(400, "invalidFilter", "Unsupported filter");
	return { [attr]: m[2].replace(/\\(.)/g, "$1") } as Partial<Record<A, string>>;
}

export function paging(params: URLSearchParams) {
	const start = Math.max(1, Number.parseInt(params.get("startIndex") ?? "1", 10) || 1);
	const count = Math.min(MAX_RESULTS, Math.max(0, Number.parseInt(params.get("count") ?? "100", 10) || 0));
	return { offset: start - 1, limit: count, startIndex: start };
}
