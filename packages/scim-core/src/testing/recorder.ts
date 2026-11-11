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

/** Replaces personal values with stable placeholders, so that lookups still match creates. */
function createScrubber() {
	const seen = new Map<string, string>();
	const placeholder = (value: string) => {
		const key = value.toLowerCase();
		if (!seen.has(key)) seen.set(key, `person-${seen.size + 1}`);
		return seen.get(key)!;
	};
	const scrub = (value: unknown, key?: string, contact = false): unknown => {
		if (Array.isArray(value)) return value.map((v) => scrub(v, key, contact));
		if (typeof value === "object" && value !== null)
			return Object.fromEntries(
				Object.entries(value)
					.filter(([k]) => !secrets.has(k.toLowerCase()))
					.map(([k, v]) => [k, scrub(v, k, contact || contacts.has(k.toLowerCase()))]),
			);
		if (typeof value !== "string" || !value) return value;
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

/** Longest body kept in a recording, matching the SCIM handler's own limit. */
const MAX_RECORDED_BYTES = 1 << 20;

/** The body as text, or undefined when it is longer than a recording keeps. */
async function capped(message: Request | Response): Promise<string | undefined> {
	if (!message.body) return undefined;
	const reader = message.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_RECORDED_BYTES) {
			await reader.cancel().catch(() => {});
			return undefined;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
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
			// Cloned before the handler consumes it, and read only after it has answered.
			const copy = request.body ? request.clone() : undefined;
			const response = await scim.handle(request);
			// An unauthenticated request is not a provider's traffic, so its body is never read.
			if (response.status === 401) return response;
			try {
				const url = new URL(request.url);
				const path = url.pathname.slice(url.pathname.startsWith(basePath) ? basePath.length : 0) + url.search;
				const sent = copy ? await capped(copy) : undefined;
				const body = sent ? parsed(sent) : undefined;
				const answer = parsed((await capped(response.clone())) ?? "");
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
