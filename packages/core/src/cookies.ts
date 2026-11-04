export type CookieOptions = {
	path?: string;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: "lax" | "strict" | "none";
	maxAge?: number;
};

/** Browsers cap a cookie near 4096 bytes; leave room for name and attributes. */
export const CHUNK_SIZE = 3800;

export function parseCookies(header: string | null | undefined) {
	const cookies = new Map<string, string>();
	for (const part of header?.split(";") ?? []) {
		const index = part.indexOf("=");
		if (index < 1) continue;
		const name = part.slice(0, index).trim();
		const raw = part.slice(index + 1).trim();
		try {
			cookies.set(name, decodeURIComponent(raw));
		} catch {
			cookies.set(name, raw);
		}
	}
	return cookies;
}

export function serializeCookie(
	name: string,
	value: string,
	options: CookieOptions,
) {
	const parts = [`${name}=${encodeURIComponent(value)}`];
	if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
	parts.push(`Path=${options.path ?? "/"}`);
	if (options.httpOnly) parts.push("HttpOnly");
	if (options.secure) parts.push("Secure");
	if (options.sameSite) {
		parts.push(
			`SameSite=${options.sameSite[0]?.toUpperCase()}${options.sameSite.slice(1)}`,
		);
	}
	return parts.join("; ");
}

function chunkNames(cookies: Map<string, string>, name: string) {
	const pattern = new RegExp(`^${name.replace(/[.-]/g, "\\$&")}\\.(\\d+)$`);
	return [...cookies.keys()]
		.map((key) => ({ key, index: Number(pattern.exec(key)?.[1]) }))
		.filter(({ index }) => Number.isInteger(index))
		.sort((a, b) => a.index - b.index);
}

/** Reads `name`, or its contiguous `name.0`, `name.1`, … chunks. */
export function readChunked(cookies: Map<string, string>, name: string) {
	const whole = cookies.get(name);
	if (whole !== undefined) return whole;
	const chunks = chunkNames(cookies, name);
	if (chunks.length === 0 || chunks.some(({ index }, i) => index !== i)) {
		return undefined;
	}
	return chunks.map(({ key }) => cookies.get(key)).join("");
}

/** Set-Cookie lines that delete `name` and every chunk of it. */
export function clearChunked(
	cookies: Map<string, string>,
	name: string,
	options: CookieOptions,
) {
	const expired = { ...options, maxAge: 0 };
	const keys = [
		...(cookies.has(name) ? [name] : []),
		...chunkNames(cookies, name).map(({ key }) => key),
	];
	return keys.map((key) => serializeCookie(key, "", expired));
}

/**
 * Set-Cookie lines that store `value` under `name`, splitting it into
 * `name.0..n` chunks when it is too large for one cookie, and deleting any
 * stale cookie or chunk left from a previous size.
 */
export function writeChunked(
	cookies: Map<string, string>,
	name: string,
	value: string,
	options: CookieOptions,
) {
	const encoded = encodeURIComponent(value);
	if (encoded.length <= CHUNK_SIZE) {
		return [
			serializeCookie(name, value, options),
			...clearChunked(
				new Map(chunkNames(cookies, name).map(({ key }) => [key, ""])),
				name,
				options,
			),
		];
	}
	// Split the plain value so no percent-escape is cut in half.
	const chunks: string[] = [];
	let current = "";
	for (const character of value) {
		if (encodeURIComponent(current + character).length > CHUNK_SIZE) {
			chunks.push(current);
			current = "";
		}
		current += character;
	}
	if (current) chunks.push(current);
	const written = chunks.map((chunk, index) =>
		serializeCookie(`${name}.${index}`, chunk, options),
	);
	const stale = clearChunked(cookies, name, options).filter((line) => {
		const key = line.slice(0, line.indexOf("="));
		const index = Number(key.slice(name.length + 1));
		return key === name || index >= chunks.length;
	});
	return [...written, ...stale];
}
