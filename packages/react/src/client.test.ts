import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import type { AuthUser } from "@lpshanley/oidc-start-core/models";
import { OidcAuthProvider, useAuth } from "./client.js";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("./functions.js", () => ({ signOut: vi.fn(), getSignInUrl: vi.fn() }));

const member = { sub: "1", email: "member@example.com", name: null, roles: ["member"] };

function render(user: AuthUser | null, children: ReactNode) {
	return renderToStaticMarkup(createElement(OidcAuthProvider, { auth: { user }, children }));
}

test("the hook checks roles against the loader's user, including older sessions", () => {
	function Menu() {
		return useAuth().hasRole("member") ? "account" : "public";
	}
	expect(render(member, createElement(Menu))).toBe("account");
	expect(render({ ...member, roles: undefined }, createElement(Menu))).toBe("public");
	expect(render(null, createElement(Menu))).toBe("public");
});
