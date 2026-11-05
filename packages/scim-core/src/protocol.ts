import { ScimError } from "./errors.js";
import type { ScimGroupChange, ScimGroupFields, ScimName, ScimUserFields } from "./types.js";

export const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const MAX_RESULTS = 200;

const invalid = (detail: string) => new ScimError(400, "invalidValue", detail);
const noTarget = () => new ScimError(400, "noTarget", "remove needs a path");

type Json = Record<string, unknown>;
const object = (v: unknown): Json => {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid("Expected a JSON object");
	return v as Json;
};
const text = (v: unknown, max = 256) =>
	typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined;
const required = (v: unknown, attribute: string) => {
	const value = text(v);
	if (!value) throw invalid(`${attribute} must be a string`);
	return value;
};
/** Some providers send booleans as strings. */
const bool = (v: unknown) => {
	if (typeof v === "boolean") return v;
	return typeof v === "string" && /^(true|false)$/i.test(v) ? v.toLowerCase() === "true" : undefined;
};

function activeOf(u: Json) {
	if (u.active === undefined) return undefined;
	const active = bool(u.active);
	if (active === undefined) throw invalid("active must be a boolean");
	return active;
}

const NAME_PARTS = ["formatted", "givenName", "familyName"] as const;
function nameOf(value: unknown, current: ScimName | null = null): ScimName | null {
	const given = value && typeof value === "object" ? (value as Json) : {};
	const next: ScimName = { ...current };
	for (const part of NAME_PARTS) {
		const key = Object.keys(given).find((k) => k.toLowerCase() === part.toLowerCase());
		if (key) next[part] = text(given[key]);
		if (next[part] === undefined) delete next[part];
	}
	return Object.keys(next).length ? next : null;
}

/** A full User resource from POST or PUT. */
export function parseUser(body: unknown): ScimUserFields {
	const u = object(body);
	return {
		userName: required(u.userName, "userName"),
		externalId: text(u.externalId) ?? null,
		displayName: text(u.displayName) ?? null,
		name: nameOf(u.name),
		active: activeOf(u) ?? true,
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
		active: activeOf(object(body)) ?? current.active,
	};
}

type Op = { op?: unknown; path?: unknown; value?: unknown };
function operations(body: unknown): Op[] {
	const b = object(body);
	if (!Array.isArray(b.Operations) || !b.Operations.length) throw invalid("Operations are required");
	if (Array.isArray(b.schemas) && !b.schemas.includes(PATCH)) throw invalid("Expected the PatchOp schema");
	return b.Operations as Op[];
}
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
			next.active = activeOf({ active: value }) ?? next.active;
		} else if (p === "username") {
			next.userName = required(value, "userName");
		} else if (p === "externalid") {
			next.externalId = required(value, "externalId");
		} else if (p === "displayname") {
			next.displayName = text(value) ?? null;
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
		else for (const [k, v] of Object.entries(object(o.value))) set(k, v);
	}
	return next;
}

const memberIds = (v: unknown) =>
	(Array.isArray(v) ? v : [v]).flatMap((m) =>
		m && typeof m === "object" && typeof (m as Json).value === "string" ? [(m as Json).value as string] : [],
	);

export function parseGroup(body: unknown): ScimGroupFields {
	const g = object(body);
	return {
		displayName: required(g.displayName, "displayName"),
		externalId: text(g.externalId) ?? null,
		memberIds: memberIds(g.members ?? []),
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
			patch.push({ kind: "rename", displayName: required(o.value, "displayName") });
		else if ((op === "replace" || op === "add") && !path) {
			const v = object(o.value);
			if (v.displayName !== undefined)
				patch.push({ kind: "rename", displayName: required(v.displayName, "displayName") });
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
