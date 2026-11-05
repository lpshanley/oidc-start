import type { ScimAdapter } from "./adapter.js";
import { ScimError } from "./errors.js";
import { createOperations, type ScimHooks } from "./operations.js";
import { paging, parseFilter, parseGroup, patchGroup } from "./protocol.js";
import { listResponse, resourceTypes, schemas, serviceProviderConfig, toGroup, toUser } from "./resources.js";
import type { ScimUser } from "./types.js";

const TYPE = "application/scim+json";
const MAX_BODY_BYTES = 1 << 20;

/** A request that was refused, or that failed for a reason the provider can retry. */
export type ScimProblem = {
	kind: "refused" | "failed" | "after-commit";
	method: string;
	/** Refusals only. */
	status?: number;
	scimType?: string;
	error: unknown;
};

export type ScimOptions<TConnection, TUser extends ScimUser, TTransaction> = ScimHooks<TConnection, TUser, TTransaction> & {
	adapter: ScimAdapter<TConnection, TUser, TTransaction>;
	/**
	 * The connection a bearer token belongs to, or null to refuse it. Compare
	 * digests of a high-entropy token, and never store or log the token itself.
	 */
	authenticate(token: string, request: Request): Promise<TConnection | null | undefined>;
	/** When this resolves false the endpoint answers 404, for example until a token exists. */
	enabled?(): Promise<boolean>;
	/** Where the routes are mounted. Defaults to /scim/v2. */
	basePath?: string;
	/** The public origin, when `request.url` does not carry it behind a proxy. */
	origin?: string;
	documentationUri?: string;
	/** A refused request can leave a leaver with access, so report these. Must not throw. */
	onProblem?(problem: ScimProblem): void;
};

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": TYPE, "cache-control": "no-store", ...headers },
	});

async function text(request: Request) {
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > MAX_BODY_BYTES) throw new ScimError(413);
	if (!request.body) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
		size += chunk.byteLength;
		if (size > MAX_BODY_BYTES) throw new ScimError(413);
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function body(request: Request) {
	const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
	if (type !== TYPE && type !== "application/json") throw new ScimError(415, undefined, `Use ${TYPE}`);
	const source = await text(request);
	try {
		return JSON.parse(source);
	} catch {
		throw new ScimError(400, "invalidSyntax", "Malformed JSON");
	}
}

function segments(pathname: string, basePath: string) {
	if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) throw new ScimError(404);
	try {
		return pathname.slice(basePath.length).split("/").filter(Boolean).map(decodeURIComponent);
	} catch {
		throw new ScimError(404);
	}
}

/** The whole list, or one entry as a plain object (RFC 7644 §4). */
function discovery<T extends { id: string }>(items: T[], id?: string) {
	if (!id) return json(listResponse(items, items.length, 1));
	const item = items.find((i) => i.id === id);
	if (!item) throw new ScimError(404, undefined, "Resource not found");
	return json(item);
}

/** SCIM 2.0 (RFC 7644) Users and Groups for an identity provider. */
export function createScim<TConnection, TUser extends ScimUser = ScimUser, TTransaction = undefined>(
	options: ScimOptions<TConnection, TUser, TTransaction>,
) {
	const basePath = (options.basePath ?? "/scim/v2").replace(/\/+$/, "");
	const report = (problem: ScimProblem) => options.onProblem?.(problem);
	const forConnection = (connection: TConnection, method = "direct") =>
		createOperations(
			{
				...options,
				afterCommitFailed: (error) => report({ kind: "after-commit", method, error }),
			},
			connection,
		);

	async function route(request: Request) {
		if (options.enabled && !(await options.enabled())) return new Response(null, { status: 404 });
		const match = /^Bearer ([-._~+/A-Za-z0-9]+=*)$/i.exec(request.headers.get("authorization") ?? "");
		const connection = match ? await options.authenticate(match[1], request) : null;
		if (connection === null || connection === undefined)
			return json(new ScimError(401, undefined, "Bearer token required").body(), 401, {
				"www-authenticate": 'Bearer realm="scim"',
			});
		const url = new URL(request.url);
		const base = (options.origin ?? url.origin) + basePath;
		const [resource, id, extra] = segments(url.pathname, basePath);
		if (extra) throw new ScimError(404);
		const { method } = request;
		if (
			["ServiceProviderConfig", "ResourceTypes", "Schemas"].includes(resource) &&
			method === "GET" &&
			url.searchParams.has("filter")
		)
			throw new ScimError(403, undefined, "Filtering is not supported");
		// RFC 7644 §3.11, and bulk is declared unsupported in discovery.
		if (resource === "Me" || resource === "Bulk") throw new ScimError(501, undefined, "Not supported");
		if (resource === "ServiceProviderConfig" && method === "GET")
			return json(serviceProviderConfig(options.documentationUri));
		if (resource === "ResourceTypes" && method === "GET") return discovery(resourceTypes(base), id);
		if (resource === "Schemas" && method === "GET") return discovery(schemas(base), id);
		const { users, groups } = forConnection(connection, method);
		if (resource === "Users") {
			if (!id && method === "GET") {
				const page = paging(url.searchParams);
				const filter = parseFilter(url.searchParams.get("filter"), ["userName", "externalId"]);
				const result = await users.list(filter, page.offset, page.limit);
				return json(listResponse(result.items.map((u) => toUser(u, base)), result.total, page.startIndex));
			}
			if (!id && method === "POST") {
				const user = toUser(await users.create(await body(request)), base);
				return json(user, 201, { location: user.meta.location });
			}
			if (id && method === "GET") return json(toUser(await users.get(id), base));
			if (id && method === "PUT") return json(toUser(await users.replace(id, await body(request)), base));
			if (id && method === "PATCH") return json(toUser(await users.patch(id, await body(request)), base));
			if (id && method === "DELETE") {
				await users.delete(id);
				return new Response(null, { status: 204 });
			}
		}
		if (resource === "Groups") {
			if (!id && method === "GET") {
				const page = paging(url.searchParams);
				const filter = parseFilter(url.searchParams.get("filter"), ["displayName", "externalId"]);
				const result = await groups.list(filter, page.offset, page.limit);
				return json(listResponse(result.items.map((g) => toGroup(g, base)), result.total, page.startIndex));
			}
			if (!id && method === "POST") {
				const group = toGroup(await groups.create(parseGroup(await body(request))), base);
				return json(group, 201, { location: group.meta.location });
			}
			if (id && method === "GET") return json(toGroup(await groups.get(id), base));
			if (id && method === "PUT") return json(toGroup(await groups.replace(id, parseGroup(await body(request))), base));
			if (id && method === "PATCH") return json(toGroup(await groups.patch(id, patchGroup(await body(request))), base));
			if (id && method === "DELETE") {
				await groups.delete(id);
				return new Response(null, { status: 204 });
			}
		}
		throw new ScimError(resource === "Users" || resource === "Groups" ? 405 : 404, undefined, "Not supported");
	}

	return {
		/** Answers a request for the mounted path. Never rejects. */
		async handle(request: Request): Promise<Response> {
			try {
				return await route(request);
			} catch (error) {
				if (error instanceof ScimError) {
					if (error.status !== 404)
						report({
							kind: "refused",
							method: request.method,
							status: error.status,
							scimType: error.scimType,
							error,
						});
					return json(error.body(), error.status);
				}
				report({ kind: "failed", method: request.method, error });
				// Never a 404: a provider would take the user to be gone.
				return json(new ScimError(503, undefined, "Temporarily unavailable").body(), 503);
			}
		},
		/** The same operations without HTTP, for application code and tests. */
		forConnection: (connection: TConnection) => forConnection(connection),
	};
}
