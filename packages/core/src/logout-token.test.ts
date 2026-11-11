import { expect, test } from "vitest";
import { BACKCHANNEL_LOGOUT_EVENT, logoutTarget } from "./logout-token.js";

const valid = {
	events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
	iat: 100,
	exp: 200,
	jti: " token-1 ",
	sid: "session",
	sub: "user",
};

test("a logout token names a session, a user, or both, and keeps its token ID as sent", () => {
	const event = { issuedAt: 100, expiresAt: 200, jti: " token-1 " };
	expect(logoutTarget(valid)).toEqual({ ...event, sid: "session", sub: "user" });
	expect(logoutTarget({ ...valid, sid: undefined })).toEqual({ ...event, sub: "user" });
	expect(logoutTarget({ ...valid, sub: 7 as never })).toEqual({ ...event, sid: "session" });
});

test.each([
	["no event", { events: {} }, "no back-channel logout event"],
	["an event array", { events: { [BACKCHANNEL_LOGOUT_EVENT]: [] } }, "no back-channel logout event"],
	["a null event", { events: { [BACKCHANNEL_LOGOUT_EVENT]: null } }, "no back-channel logout event"],
	["no issued-at time", { iat: undefined }, "no issued-at time"],
	["a blank token ID", { jti: "  " }, "no token ID"],
	["no expiry", { exp: undefined }, "Missing expiry"],
	["a nonce", { nonce: "n" }, "must not carry a nonce"],
	["neither target", { sid: "", sub: "" }, "neither a session nor a user"],
])("a logout token with %s is refused", (_, claims, message) => {
	expect(() => logoutTarget({ ...valid, ...claims } as never)).toThrow(message);
});
