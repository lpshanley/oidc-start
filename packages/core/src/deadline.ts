import type { OidcCallContext } from "./config.js";

/** The caller's deadline passed before the provider answered. */
export class OidcDeadlineError extends Error {
	override name = "OidcDeadlineError";
	constructor() {
		super("The request deadline passed before the provider answered");
	}
}

/**
 * Settles with the work, or rejects once the caller's deadline passes. Each
 * provider request also has its own timeout, so abandoned work still ends.
 */
export async function withinDeadline<T>(
	start: () => Promise<T>,
	context?: OidcCallContext,
	now = Date.now(),
): Promise<T> {
	if (context?.deadline === undefined) return start();
	const remaining = context.deadline - now;
	if (remaining <= 0) throw new OidcDeadlineError();
	const work = start();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new OidcDeadlineError()), remaining);
	});
	return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
