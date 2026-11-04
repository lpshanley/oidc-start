import { createHash } from "node:crypto";
import { z } from "zod";
import { RefreshNotDispatched, type RefreshedTokens } from "./provider.js";
import type { Session } from "./session.js";
import { sealValue, unsealValue } from "./seal.js";

export const RECENT_REFRESH_MS = 10_000;
export type RefreshCoordinationResult =
	| { status: "ready"; sealedResult: string }
	| { status: "busy" }
	| { status: "reauth_required" };

/** Shared rotation ownership. Reserve before dispatch, retain spent keys until expiry. */
export interface SessionRefreshCoordinator {
	run(
		request: { key: string; until: number; reuseMs: number },
		produce: () => Promise<string>,
	): Promise<RefreshCoordinationResult>;
}

/** One process only. Production replicas must use the same durable coordinator. */
export function createMemoryRefreshCoordinator(now = Date.now): SessionRefreshCoordinator {
	type Entry = { until: number; result: Promise<RefreshCoordinationResult>; completedAt?: number };
	const entries = new Map<string, Entry>();
	return {
		async run({ key, until, reuseMs }, produce) {
			for (const [id, entry] of entries) if (entry.until * 1000 <= now()) entries.delete(id);
			const existing = entries.get(key);
			if (existing) {
				if (existing.completedAt !== undefined && now() >= existing.completedAt + reuseMs) return { status: "reauth_required" };
				return existing.result;
			}
			const entry: Entry = { until, result: Promise.resolve().then(produce).then(
				(sealedResult): RefreshCoordinationResult => {
					entry.completedAt = now();
					return { status: "ready", sealedResult };
				},
				(error: unknown): RefreshCoordinationResult => {
					if (error instanceof RefreshNotDispatched) { entries.delete(key); throw error; }
					entry.completedAt = now();
					return { status: "reauth_required" };
				},
			) };
			entries.set(key, entry);
			return entry.result;
		},
	};
}

const refreshResult = z.object({
	key: z.string(), useBefore: z.number(),
	tokens: z.object({
		accessToken: z.string().min(1), refreshToken: z.string().min(1).optional(),
		idToken: z.string().min(1).optional(), expiresAt: z.number(),
		refreshExpiresAt: z.number().optional(), roles: z.array(z.string()),
		email: z.string().min(1).optional(),
	}),
});

export async function sharedRefresh(coordinator: SessionRefreshCoordinator, {
	session, until, password, refresh,
}: { session: Session; until: number; password: string; refresh: () => Promise<RefreshedTokens> }) {
	const key = createHash("sha256").update(JSON.stringify([
		session.user.issuer, session.clientId, session.sid, session.user.sub,
		session.refreshGeneration ?? 0, session.refreshToken,
	])).digest("hex");
	const result = await coordinator.run({ key, until, reuseMs: RECENT_REFRESH_MS }, async () => {
		const tokens = await refresh();
		return sealValue({ key, tokens, useBefore: Date.now() + RECENT_REFRESH_MS }, password, RECENT_REFRESH_MS / 1000);
	});
	if (result.status !== "ready") return result;
	try {
		const decoded = refreshResult.parse(await unsealValue(result.sealedResult, password, RECENT_REFRESH_MS / 1000));
		if (decoded.key === key && Date.now() < decoded.useBefore) return { status: "ready" as const, tokens: decoded.tokens };
	} catch { /* An expired or mismatched result never authorizes a request. */ }
	return { status: "reauth_required" as const };
}
