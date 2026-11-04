import { createHash } from "node:crypto";
import { z } from "zod";
import type { RefreshedTokens } from "./provider.js";
import type { Session } from "./session.js";
import { sealValue, unsealValue } from "./seal.js";

/** Reuse a recent refresh when a concurrent request still has the old cookie. */
export const RECENT_REFRESH_MS = 10_000;

/** Coordinate a session refresh across replicas of one app. Times named "until" are epoch seconds. */
export interface SessionRefreshCoordinator {
	/**
	 * Atomically reserve the key before calling produce. Keep the reservation through
	 * until, even if the outcome is unknown. Concurrent callers may reuse the sealed
	 * result for reuseMs after completion. Return null for a spent key or wait timeout.
	 */
	run(
		request: { key: string; until: number; reuseMs: number },
		produce: () => Promise<string>,
	): Promise<string | null>;
}

const refreshResult = z.object({
	key: z.string(),
	useBefore: z.number(),
	tokens: z.object({
		accessToken: z.string().min(1),
		refreshToken: z.string().min(1).optional(),
		idToken: z.string().min(1).optional(),
		expiresAt: z.number(),
		refreshExpiresAt: z.number().optional(),
		roles: z.array(z.string()),
		email: z.string().min(1).optional(),
	}),
});

export async function sharedRefresh(
	coordinator: SessionRefreshCoordinator,
	{ session, until, password, refresh }: {
		session: Session;
		until: number;
		password: string;
		refresh: () => Promise<RefreshedTokens>;
	},
) {
	// Some providers return the same refresh token on successive renewals.
	// Each generation gets its own reservation within this sign-in.
	const key = createHash("sha256").update(JSON.stringify([
		session.sid, session.user.sub, session.refreshGeneration ?? 0, session.refreshToken,
	])).digest("hex");
	const ttl = RECENT_REFRESH_MS / 1000;
	const sealed = await coordinator.run({ key, until, reuseMs: RECENT_REFRESH_MS }, async () => {
		const tokens = await refresh();
		return sealValue({ key, tokens, useBefore: Date.now() + RECENT_REFRESH_MS }, password, ttl);
	});
	if (sealed === null) return null;
	const result = refreshResult.parse(await unsealValue(sealed, password, ttl));
	if (result.key !== key) throw new Error("Mismatched session refresh result");
	return Date.now() < result.useBefore ? result.tokens : null;
}
