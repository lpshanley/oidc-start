import { MAX_BODY_BYTES, readBody } from "../body.js";
import { operationKeys } from "../protocol.js";

export type ScimExchange = {
	method: string;
	/** The path and query, relative to where the routes are mounted. */
	path: string;
	body?: unknown;
	status: number;
	response?: unknown;
};

type Handler = { handle(request: Request): Promise<Response> };

const PERSONAL = new Set([
	// Entra sends a mail alias as externalId by default.
	"externalId",
	"userName",
	"displayName",
	"display",
	"formatted",
	"familyName",
	"givenName",
	"middleName",
	"nickName",
	"title",
	"streetAddress",
	"locality",
	"postalCode",
	"department",
	"employeeNumber",
	"region",
	"country",
	"organization",
	"division",
	"costCenter",
	"profileUrl",
]);
// A manager's value is often the manager's own userName, as Okta sends it.
const CONTACT = new Set(["emails", "phoneNumbers", "ims", "photos", "manager"]);
const SECRET = new Set(["password"]);

// SCIM attribute names are case-insensitive (RFC 7643 section 2.1), so the sets are compared in lower case.
const lower = (names: Set<string>) => new Set([...names].map((name) => name.toLowerCase()));
const personal = lower(PERSONAL);
const contacts = lower(CONTACT);
const secrets = lower(SECRET);

/** What a PATCH path such as `phoneNumbers[type eq "work"].value` or a URN ending in `:manager` points at. */
function pathTarget(path: string) {
	const names = path
		.replace(/\[[^\]]*\]/g, "")
		.split(/[.:]/)
		.map((name) => name.toLowerCase());
	const key = names.at(-1) ?? "";
	return {
		key,
		contact: names.some((name) => contacts.has(name)),
		/** The path ends on the contact attribute itself, so a string value is that contact's value. */
		bare: contacts.has(key),
		secret: names.some((name) => secrets.has(name)),
	};
}

/** Replaces personal values with stable placeholders, so that lookups still match creates. */
function createScrubber() {
	const seen = new Map<string, string>();
	const placeholder = (value: string) => {
		const key = value.toLowerCase();
		if (!seen.has(key)) seen.set(key, `person-${seen.size + 1}`);
		return seen.get(key)!;
	};
	// Keep membership ids for replay and standard type labels for selecting entries.
	const selector = (path: string) => {
		if (!path.includes("[")) return path;
		return path.replace(/(?:([\w$.-]+)(\s+\w+\s+))?"((?:[^"\\]|\\.)*)"/g, (match, field: string | undefined, op: string | undefined, literal: string) => {
			if (field?.toLowerCase() === "type" && /^(work|home|other|mobile|fax|pager|main)$/i.test(literal)) return match;
			if (/(?:^|:)members\[/i.test(path) && field?.toLowerCase() === "value" && !literal.includes("@")) return match;
			return (field ?? "") + (op ?? "") + '"' + placeholder(literal.replace(/\\(.)/g, "$1")) + '"';
		});
	};
	const scrub = (value: unknown, key?: string, contact = false): unknown => {
		if (Array.isArray(value)) return value.map((v) => scrub(v, key, contact));
		if (typeof value === "object" && value !== null) {
			// A PATCH operation with a path names its attribute there, not in a key, as Entra sends it.
			const fields = Object.keys(value).some((k) => k.toLowerCase() === "path")
				? operationKeys(value) as Record<string, unknown> : value;
			const target = "path" in fields && typeof fields.path === "string" ? pathTarget(fields.path) : undefined;
			return Object.fromEntries(
				Object.entries(fields)
					.filter(([k]) => !pathTarget(k).secret)
					.map(([k, v]) => {
						if (k === "path" && typeof v === "string") return [k, selector(v)];
						// The operation has to stay whole to replay, so a secret's value is blanked, not dropped.
						if (target?.secret && k.toLowerCase() === "value") return [k, "redacted"];
						// A key can be a path too: Entra's no-path PATCH sends "name.familyName".
						const named = target && k.toLowerCase() === "value" ? target : pathTarget(k);
						return [selector(k), scrub(v, named.bare && typeof v === "string" ? "value" : named.key, contact || named.contact)];
					}),
			);
		}
		if (typeof value !== "string" || !value) return value;
		if (key === "detail") return selector(value);
		return personal.has((key ?? "").toLowerCase()) || (contact && key?.toLowerCase() === "value") ? placeholder(value) : value;
	};
	return {
		scrub: (value: unknown) => scrub(value),
		/** A filter's values name people, so every quoted one is replaced. */
		path: (path: string) => {
			const [pathname, query] = path.split("?");
			if (!query) return path;
			const params = new URLSearchParams(query);
			const filter = params.get("filter");
			if (filter) params.set("filter", filter.replace(/"((?:[^"\\]|\\.)*)"/g, (_, value) => `"${placeholder(value)}"`));
			return `${pathname}?${params}`;
		},
	};
}

const parsed = (text: string) => {
	if (!text) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
};

/** Observe only the bytes the handler reads. Authentication and early refusals can leave the body untouched. */
function captureRequest(request: Request) {
	let captured: string | undefined;
	if (!request.body) return { request, text: () => captured };
	const source = request.body;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let chunks: Uint8Array[] = [];
	let size = 0;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			reader ??= source.getReader();
			const { done, value } = await reader.read();
			if (done) {
				if (size <= MAX_BODY_BYTES) captured = Buffer.concat(chunks).toString("utf8");
				chunks = [];
				reader.releaseLock();
				controller.close();
				return;
			}
			size += value.byteLength;
			if (size <= MAX_BODY_BYTES) chunks.push(value.slice());
			else chunks = [];
			controller.enqueue(value);
		},
		cancel(reason) {
			if (reader) {
				void reader.cancel(reason).catch(() => {});
				reader.releaseLock();
			} else {
				void source.cancel(reason).catch(() => {});
			}
		},
	}, { highWaterMark: 0 });
	return { request: new Request(request, { body, duplex: "half" } as RequestInit), text: () => captured };
}

/**
 * Wraps a `createScim` instance and reports each exchange, to capture what a
 * real provider sends. Headers are never kept, passwords are dropped, and names,
 * emails and filter values become placeholders. Ids stay, so a recording can be
 * replayed. Read a recording before committing it, because an attribute this
 * list does not know about keeps its value.
 */
export function recordTraffic(
	scim: Handler,
	options: { basePath?: string; onExchange(exchange: ScimExchange): void },
): Handler {
	const basePath = (options.basePath ?? "/scim/v2").replace(/\/+$/, "");
	const scrubber = createScrubber();
	return {
		async handle(request) {
			const capture = captureRequest(request);
			const response = await scim.handle(capture.request);
			// An unauthenticated request is not a provider's traffic, so its body is never read.
			if (response.status === 401) return response;
			try {
				const url = new URL(request.url);
				const path = url.pathname.slice(url.pathname.startsWith(basePath) ? basePath.length : 0) + url.search;
				const sent = capture.text();
				const body = sent ? parsed(sent) : undefined;
				const answer = parsed((await readBody(response.clone())) ?? "");
				options.onExchange({
					method: request.method,
					path: scrubber.path(path),
					...(body === undefined ? {} : { body: scrubber.scrub(body) }),
					status: response.status,
					...(answer === undefined ? {} : { response: scrubber.scrub(answer) }),
				});
			} catch {
				// Recording is a side effect and must never change what the provider sees.
			}
			return response;
		},
	};
}

type Mismatch = { exchange: ScimExchange; status: number };

/**
 * Sends a recording to a fresh instance and returns the exchanges whose status
 * differs. Server-issued ids from the recording are mapped to the new ones.
 */
export async function replayTraffic(
	scim: Handler,
	exchanges: ScimExchange[],
	options: {
		token?: string;
		origin?: string;
		basePath?: string;
		/** Runs before each exchange is sent, for example to make the next write fail as it did when recorded. */
		before?(exchange: ScimExchange): void | Promise<void>;
	} = {},
): Promise<Mismatch[]> {
	const { token = "test-token", origin = "https://app.test", basePath = "/scim/v2" } = options;
	const ids = new Map<string, string>();
	const mapped = (text: string) => [...ids].reduce((out, [from, to]) => out.replaceAll(from, to), text);
	const mismatches: Mismatch[] = [];
	for (const exchange of exchanges) {
		await options.before?.(exchange);
		const body = exchange.body === undefined ? undefined : mapped(JSON.stringify(exchange.body));
		const response = await scim.handle(
			new Request(origin + basePath + mapped(exchange.path), {
				method: exchange.method,
				headers: {
					authorization: `Bearer ${token}`,
					...(body === undefined ? {} : { "content-type": "application/scim+json" }),
				},
				...(body === undefined ? {} : { body }),
			}),
		);
		const text = await response.text();
		if (response.status !== exchange.status) mismatches.push({ exchange, status: response.status });
		const recorded = (exchange.response as { id?: unknown } | undefined)?.id;
		const issued = (parsed(text) as { id?: unknown } | undefined)?.id;
		if (exchange.method === "POST" && typeof recorded === "string" && typeof issued === "string") ids.set(recorded, issued);
	}
	return mismatches;
}
