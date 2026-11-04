import { afterEach, describe, expect, test, vi } from "vitest";
import {
	CHUNK_SIZE,
	clearChunked,
	parseCookies,
	readChunked,
	serializeCookie,
	writeChunked,
} from "./cookies.js";
import { sealValue, unsealValue } from "./seal.js";

const password = "test-only-session-secret-at-least-32-characters";
const options = { path: "/", httpOnly: true, sameSite: "lax" as const };

afterEach(() => vi.useRealTimers());

/** Applies Set-Cookie lines to a cookie jar the way a browser would. */
function apply(jar: Map<string, string>, lines: string[]) {
	for (const line of lines) {
		const [pair = ""] = line.split(";");
		const name = pair.slice(0, pair.indexOf("="));
		if (/Max-Age=0(;|$)/.test(line)) jar.delete(name);
		else jar.set(name, decodeURIComponent(pair.slice(name.length + 1)));
	}
	return jar;
}

describe("seals", () => {
	test("round-trip data with an iron-session version suffix", async () => {
		const sealed = await sealValue({ sub: "alice" }, password, 60);

		expect(sealed.endsWith("~2")).toBe(true);
		await expect(unsealValue(sealed, password, 60)).resolves.toEqual({
			sub: "alice",
		});
	});

	test.each([
		["tampered", (s: string) => `${s.slice(0, 40)}x${s.slice(41)}`, password],
		["unversioned", (s: string) => s.replace(/~2$/, ""), password],
		["foreign", (s: string) => s, "another-secret-that-is-at-least-32-chars"],
	])("reject %s seals", async (_, alter, key) => {
		const sealed = alter(await sealValue({ sub: "alice" }, password, 60));

		await expect(unsealValue(sealed, key, 60)).rejects.toThrow();
	});

	test("expire after their ttl plus skew", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: 0 });
		const sealed = await sealValue({ sub: "alice" }, password, 60);
		vi.setSystemTime(60_000 + 61_000);

		await expect(unsealValue(sealed, password, 60)).rejects.toThrow();
	});
});

describe("cookies", () => {
	test("parse and decode a cookie header", () => {
		expect(parseCookies("a=1; b=x%20y;bad; c=%E0")).toEqual(
			new Map([
				["a", "1"],
				["b", "x y"],
				["c", "%E0"],
			]),
		);
		expect(parseCookies(null).size).toBe(0);
	});

	test("serialize attributes", () => {
		expect(
			serializeCookie("s", "a b", { ...options, secure: true, maxAge: 5 }),
		).toBe("s=a%20b; Max-Age=5; Path=/; HttpOnly; Secure; SameSite=Lax");
	});

	test("store a small value whole and drop old chunks", () => {
		const jar = new Map([
			["s.0", "old"],
			["s.1", "old"],
		]);

		apply(jar, writeChunked(jar, "s", "small", options));

		expect([...jar]).toEqual([["s", "small"]]);
		expect(readChunked(jar, "s")).toBe("small");
	});

	test("split a large value into chunks and read it back", () => {
		const value = "x".repeat(CHUNK_SIZE * 2 + 10);
		const jar = apply(new Map([["s", "old"]]), []);

		const lines = writeChunked(jar, "s", value, options);
		apply(jar, lines);

		expect([...jar.keys()].sort()).toEqual(["s.0", "s.1", "s.2"]);
		expect(lines.every((line) => line.length < 4096)).toBe(true);
		expect(readChunked(jar, "s")).toBe(value);
	});

	test("shrinking from three chunks to two removes the stale one", () => {
		const jar = apply(
			new Map(),
			writeChunked(new Map(), "s", "y".repeat(CHUNK_SIZE * 3), options),
		);

		apply(jar, writeChunked(jar, "s", "z".repeat(CHUNK_SIZE * 2), options));

		expect([...jar.keys()].sort()).toEqual(["s.0", "s.1"]);
		expect(readChunked(jar, "s")).toBe("z".repeat(CHUNK_SIZE * 2));
	});

	test("ignore incomplete chunk sets and clear every part", () => {
		const jar = new Map([
			["s.0", "a"],
			["s.2", "c"],
		]);

		expect(readChunked(jar, "s")).toBeUndefined();
		expect(apply(jar, clearChunked(jar, "s", options)).size).toBe(0);
	});
});
