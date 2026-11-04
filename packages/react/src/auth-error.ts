import type { CallbackErrorReason } from "@lpshanley/oidc-start-core";

const retry = "Sign-in could not be completed. Please try again.";
const messages = {
	access_denied: "Sign-in was declined. You can try again.",
	sign_in_expired: "Your sign-in request expired. Please start again.",
	invalid_callback: retry,
	invalid_state: retry,
	provider_error: "Your identity provider could not complete sign-in. Please try again.",
	token_exchange_failed: retry,
	session_failed: retry,
} satisfies Record<CallbackErrorReason, string>;

/** Safe display text for a callback reason or an untrusted auth_error query value. */
export function authErrorMessage(reason: unknown): string {
	if (typeof reason === "string" && Object.hasOwn(messages, reason)) {
		return messages[reason as CallbackErrorReason];
	}
	return retry;
}
