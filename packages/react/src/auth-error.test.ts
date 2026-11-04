import { expect, test } from "vitest";
import { authErrorMessage } from "./auth-error.js";

test("callback messages distinguish denial and expiry, with fixed text for untrusted input", () => {
	expect(authErrorMessage("access_denied")).toContain("declined");
	expect(authErrorMessage("sign_in_expired")).toContain("expired");
	for (const value of ["<script>", "__proto__", "constructor", null, {}]) {
		expect(authErrorMessage(value)).toBe("Sign-in could not be completed. Please try again.");
	}
});
