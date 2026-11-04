import { afterEach, describe, expect, test, vi } from "vitest";
import { sealValue } from "./seal.js";
import {
	fnv1a32Hex,
	OidcStateError,
	sealState,
	staleVerifierNames,
	verifierCookieName,
	verifyCallbackState,
} from "./state.js";

const password = "test-only-session-secret-at-least-32-characters";
const flow = { nonce: "n", codeVerifier: "v", returnPathname: "/projects" };

afterEach(() => vi.useRealTimers());

describe("flow state", () => {
	test("names verifier cookies by a stable hash of the sealed state", async () => {
		const sealed = await sealState(flow, password);

		expect(fnv1a32Hex("")).toBe("811c9dc5");
		expect(verifierCookieName("sage", sealed)).toBe(
			`sage-verifier-${fnv1a32Hex(sealed)}`,
		);
	});

	test("verifies a matching state and cookie", async () => {
		const sealed = await sealState(flow, password);

		await expect(
			verifyCallbackState({ state: sealed, cookieValue: sealed, password }),
		).resolves.toMatchObject(flow);
	});

	test.each([
		["missing", undefined],
		["mismatch", "something-else"],
	] as const)("rejects a %s cookie", async (reason, cookieValue) => {
		const sealed = await sealState(flow, password);

		await expect(
			verifyCallbackState({ state: sealed, cookieValue, password }),
		).rejects.toEqual(new OidcStateError(reason));
	});

	test("rejects a forged seal, a foreign shape, and an expired flow", async () => {
		const forged = await sealState(
			flow,
			"another-secret-that-is-at-least-32-chars",
		);
		const shape = await sealValue({ nonce: "n" }, password, 600);
		vi.useFakeTimers({ toFake: ["Date"], now: 0 });
		const old = await sealState(flow, password);
		vi.setSystemTime(601_000);

		for (const state of [forged, shape, old]) {
			await expect(
				verifyCallbackState({ state, cookieValue: state, password }),
			).rejects.toEqual(new OidcStateError("invalid"));
		}
	});
});

describe("verifier eviction", () => {
	const names = (count: number) =>
		Array.from({ length: count }, (_, i) => `sage-verifier-${i}`);

	test("keeps up to five pending verifiers", () => {
		expect(
			staleVerifierNames([...names(4), "sage_session", "sage-verifierX"], {
				prefix: "sage",
				keep: "sage-verifier-new",
			}),
		).toEqual([]);
	});

	test("evicts every other verifier past the limit", () => {
		expect(
			staleVerifierNames([...names(5), "sage_session"], {
				prefix: "sage",
				keep: "sage-verifier-new",
			}),
		).toEqual(names(5));
	});
});
