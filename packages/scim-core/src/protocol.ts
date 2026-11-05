import { z } from "zod";
import { ScimError } from "./errors.js";
import type { ScimAttributes, ScimEmail, ScimGroupChange, ScimGroupFields, ScimName, ScimUserFields } from "./types.js";

export const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const ENTERPRISE = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
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
const jsonArray = z.array(jsonObject);
type Json = Record<string, unknown>;

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

const NAME_PARTS = ["formatted", "familyName", "givenName", "middleName", "honorificPrefix", "honorificSuffix"] as const;
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

type User = Pick<ScimUserFields, "emails" | "attributes">;
const SINGLE = ["nickName", "profileUrl", "title", "userType", "preferredLanguage", "locale", "timezone"];
const MULTI = ["phoneNumbers", "ims", "photos", "addresses", "entitlements", "roles", "x509Certificates"];
const ENTERPRISE_PARTS = ["employeeNumber", "costCenter", "organization", "division", "department", "manager"];
const SUB_ATTRIBUTES = [
	"value",
	"display",
	"type",
	"primary",
	"formatted",
	"streetAddress",
	"locality",
	"region",
	"postalCode",
	"country",
	"displayName",
];
const named = (names: string[], name: string) => names.find((n) => n.toLowerCase() === name.toLowerCase());

type Target = { attribute: string; extension?: true; filter?: { name: string; value: string }; sub?: string };
const VALUE_PATH = /^([a-z][\w$-]*)(?:\[\s*([a-z][\w$-]*)\s+eq\s+"([^"]*)"\s*\])?(?:\.([a-z][\w$-]*))?$/i;

/** What a path or body key names among the attributes kept beyond the core ones, if anything. */
function targetOf(path: string): Target | undefined {
	const lower = path.toLowerCase();
	const core = `${USER.toLowerCase()}:`;
	const extension = lower.startsWith(`${ENTERPRISE.toLowerCase()}:`);
	const rest = extension ? path.slice(ENTERPRISE.length + 1) : lower.startsWith(core) ? path.slice(core.length) : path;
	const match = VALUE_PATH.exec(rest);
	if (!match) return undefined;
	const [, name, filterName, filterValue, subName] = match;
	const sub = subName === undefined ? undefined : named(SUB_ATTRIBUTES, subName);
	if (subName !== undefined && !sub) return undefined;
	const attribute = named(extension ? ENTERPRISE_PARTS : ["emails", ...SINGLE, ...MULTI], name);
	if (!attribute) return undefined;
	const filter = filterName === undefined ? undefined : { name: filterName, value: filterValue };
	return { attribute, ...(extension ? { extension: true } : {}), ...(filter ? { filter } : {}), ...(sub ? { sub } : {}) };
}

function entriesOf(value: unknown): Json[] {
	if (typeof value === "string") return value.trim() ? [{ value }] : [];
	const entry = jsonObject.safeParse(value);
	if (!entry.success) return [];
	const { primary, ...rest } = entry.data;
	const flag = active.safeParse(primary);
	return [{ ...rest, ...(flag.success ? { primary: flag.data } : {}) }];
}

/** A multi-valued attribute with no repeated pair and one primary (RFC 7643 §2.4). */
function multiValued(value: unknown) {
	const seen = new Set<string>();
	const entries = (Array.isArray(value) ? value : [value]).flatMap(entriesOf).filter((e) => {
		const key = JSON.stringify([e.type, e.value]);
		return !seen.has(key) && seen.add(key);
	});
	const primary = entries.map((e) => e.primary === true).lastIndexOf(true);
	return entries.map((e, i) => (e.primary === true && i !== primary ? { ...e, primary: false } : e));
}

const emailEntry = z.object({
	value: z.string().max(256).trim().min(1),
	type: text,
	display: text,
	primary: z.boolean().optional(),
});
function emailsOf(value: unknown): ScimEmail[] {
	return multiValued(value).flatMap((entry) => {
		const email = emailEntry.safeParse(entry);
		if (!email.success) return [];
		const { value, type, primary, display } = email.data;
		return [{ value, ...(type ? { type } : {}), ...(primary === undefined ? {} : { primary }), ...(display ? { display } : {}) }];
	});
}

const matching = (entry: Json, filter: NonNullable<Target["filter"]>) =>
	String(entry[named(Object.keys(entry), filter.name) ?? filter.name] ?? "").toLowerCase() === filter.value.toLowerCase();

/** Applies one write to a multi-valued attribute (RFC 7644 §3.5.2). */
function writeEntries(entries: Json[], { filter, sub }: Target, value: unknown, op: "add" | "replace") {
	if (!filter) {
		if (sub) throw invalid("A sub-attribute of a list needs a filter");
		return op === "add" ? [...entries, ...multiValued(value)] : multiValued(value);
	}
	const written = sub ? { [sub]: value } : (entriesOf(value)[0] ?? {});
	if (entries.some((e) => matching(e, filter))) return entries.map((e) => (matching(e, filter) ? { ...e, ...written } : e));
	// Entra sends replace for a typed value it has not set yet. Refusing would
	// fail the whole request, which may also be ending someone's access.
	if (op === "replace" && filter.name.toLowerCase() !== "type")
		throw new ScimError(400, "noTarget", "No value matches the path");
	return [...entries, { [filter.name]: filter.value, ...written }];
}

function removeEntries(entries: Json[], { filter, sub }: Target) {
	if (!filter) return [];
	if (!sub) return entries.filter((e) => !matching(e, filter));
	return entries.map((e) => {
		if (!matching(e, filter)) return e;
		const { [sub]: _removed, ...rest } = e;
		return rest;
	});
}

const without = (attributes: ScimAttributes, key: string) => {
	const { [key]: _removed, ...rest } = attributes;
	return rest;
};
const assigned = (attributes: ScimAttributes, key: string, value: unknown) =>
	value === undefined || (Array.isArray(value) && !value.length) ? without(attributes, key) : { ...attributes, [key]: value };

function writeExtension(user: User, { attribute, sub }: Target, value: unknown) {
	const stored = jsonObject.catch({}).parse(user.attributes[ENTERPRISE]);
	let next: unknown = text.parse(value);
	if (attribute === "manager") {
		const manager = jsonObject.catch({}).parse(stored.manager);
		if (sub) next = text.parse(value) === undefined ? without(manager, sub) : { ...manager, [sub]: text.parse(value) };
		else {
			const entry = entriesOf(value)[0];
			next = entry ?? undefined;
		}
		if (next && !Object.keys(next).length) next = undefined;
	}
	const extension = assigned(stored, attribute, next);
	user.attributes = assigned(user.attributes, ENTERPRISE, Object.keys(extension).length ? extension : undefined);
}

/** Stores one attribute beyond the core ones. A null or blank value clears it. */
function writeAttribute(user: User, target: Target, value: unknown, op: "add" | "replace") {
	const { attribute } = target;
	if (target.extension) writeExtension(user, target, value);
	else if (attribute === "emails") user.emails = emailsOf(writeEntries(user.emails, target, value, op));
	else if (SINGLE.includes(attribute)) user.attributes = assigned(user.attributes, attribute, text.parse(value));
	else {
		const entries = jsonArray.catch([]).parse(user.attributes[attribute]);
		user.attributes = assigned(user.attributes, attribute, multiValued(writeEntries(entries, target, value, op)));
	}
}

function removeAttribute(user: User, target: Target) {
	const { attribute } = target;
	if (target.extension) writeExtension(user, target, undefined);
	else if (attribute === "emails") user.emails = emailsOf(removeEntries(user.emails, target));
	else if (SINGLE.includes(attribute)) user.attributes = without(user.attributes, attribute);
	else {
		const entries = jsonArray.catch([]).parse(user.attributes[attribute]);
		user.attributes = assigned(user.attributes, attribute, multiValued(removeEntries(entries, target)));
	}
}

/** Keeps a whole enterprise object or one of its parts. A password or other key is never kept. */
function writeKey(user: User, key: string, value: unknown, op: "add" | "replace") {
	if (key.toLowerCase() === ENTERPRISE.toLowerCase()) {
		for (const [part, v] of Object.entries(jsonObject.catch({}).parse(value))) writeKey(user, `${ENTERPRISE}:${part}`, v, op);
		return;
	}
	const target = targetOf(key);
	if (target) writeAttribute(user, target, value, op);
}

function beyondCore(body: unknown): User {
	const user: User = { emails: [], attributes: {} };
	for (const [key, value] of Object.entries(read(jsonObject, body))) writeKey(user, key, value, "replace");
	return user;
}

/** A full User resource from POST or PUT. */
export function parseUser(body: unknown): ScimUserFields {
	const user = read(userResource, body);
	return {
		userName: user.userName,
		externalId: user.externalId ?? null,
		displayName: user.displayName ?? null,
		name: nameOf(user.name),
		...beyondCore(body),
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
function operations(body: unknown): Op[] {
	const ops = read(patchRequest, body).Operations;
	for (const o of ops) {
		const op = String(o.op ?? "").toLowerCase();
		// Without this, a missing value would clear the attribute it names.
		if ((op === "add" || op === "replace") && o.value === undefined) throw invalid(`${op} needs a value`);
	}
	return ops;
}
const opName = (o: Op) => String(o.op ?? "").toLowerCase();
/** A path may carry the schema it belongs to (RFC 7644 §3.10). */
const attributePath = (path: unknown) => {
	const p = String(path ?? "").toLowerCase();
	const prefix = `${USER.toLowerCase()}:`;
	return p.startsWith(prefix) ? p.slice(prefix.length) : p;
};

/**
 * Applies a PATCH to a user, in order. Attributes outside the core schema and
 * its enterprise extension are accepted and not stored, because refusing them
 * could block a deactivation sent in the same request.
 */
export function patchUser(current: ScimUserFields, body: unknown): ScimUserFields {
	const next = { ...current };
	const set = (path: string, value: unknown, op: "add" | "replace") => {
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
		} else writeKey(next, path, value, op);
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
			else if (path.startsWith("name.")) next.name = nameOf({ [path.slice("name.".length)]: undefined }, next.name);
			else {
				const target = targetOf(String(o.path));
				if (target) removeAttribute(next, target);
			}
			continue;
		}
		if (op !== "replace" && op !== "add") throw invalid(`Unsupported op ${String(o.op)}`);
		if (typeof o.path === "string" && o.path) set(o.path, o.value, op);
		else for (const [k, v] of Object.entries(read(jsonObject, o.value))) set(k, v, op);
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

/** Group PATCH: add or remove members (also `members[value eq "id"]`), replace displayName, members or externalId. */
export function patchGroup(body: unknown): ScimGroupChange[] {
	const patch: ScimGroupChange[] = [];
	for (const o of operations(body)) {
		const op = opName(o);
		const path = String(o.path ?? "");
		const filtered = /^members\[value eq "([^"]+)"\]$/i.exec(path);
		if (op === "remove" && !path) throw noTarget();
		if (op === "remove" && /^externalId$/i.test(path)) patch.push({ kind: "externalId", externalId: null });
		else if ((op === "replace" || op === "add") && /^externalId$/i.test(path))
			patch.push({ kind: "externalId", externalId: read(externalId, o.value) });
		else if (op === "add" && /^members$/i.test(path)) patch.push({ kind: "add", ids: memberIds(o.value) });
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
			if (v.externalId !== undefined) patch.push({ kind: "externalId", externalId: read(externalId, v.externalId) });
			if (v.members !== undefined)
				patch.push({ kind: op === "add" ? "add" : "replace", ids: memberIds(v.members) });
		} else throw invalid(`Unsupported group operation ${op} ${path}`);
	}
	return patch;
}

const CLAUSE = /^\s*(?:([a-z][\w.]*)|emails\[\s*type\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\]\.value)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;
const unescaped = (value: string) => value.replace(/\\(.)/g, "$1");
const unsupported = () => new ScimError(400, "invalidFilter", "Unsupported filter");

/**
 * The filters providers send to find a resource: `attr eq "value"` clauses
 * joined by `and`. `emails.value` and `emails[type eq "x"].value` become the
 * `email` and `emailType` keys.
 */
export function parseFilter<A extends string>(filter: string | null, allowed: readonly A[]): Partial<Record<A, string>> {
	if (!filter) return {};
	const result: Partial<Record<string, string>> = {};
	const add = (key: string, value: string) => {
		if (result[key] !== undefined && result[key] !== value) throw unsupported();
		result[key] = value;
	};
	for (const clause of filter.split(/\s+and\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/i)) {
		const match = CLAUSE.exec(clause);
		if (!match) throw unsupported();
		const [, attribute, emailType, value] = match;
		const key = emailType !== undefined || attribute.toLowerCase() === "emails.value" ? "email" : allowed.find((a) => a.toLowerCase() === attribute.toLowerCase());
		if (!key || !allowed.includes(key as A)) throw unsupported();
		add(key, unescaped(value));
		if (emailType !== undefined) add("emailType", unescaped(emailType));
	}
	return result as Partial<Record<A, string>>;
}

export function paging(params: URLSearchParams) {
	const start = Math.max(1, Number.parseInt(params.get("startIndex") ?? "1", 10) || 1);
	const count = Math.min(MAX_RESULTS, Math.max(0, Number.parseInt(params.get("count") ?? "100", 10) || 0));
	return { offset: start - 1, limit: count, startIndex: start };
}
