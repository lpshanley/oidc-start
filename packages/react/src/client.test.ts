import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import type { AuthUser } from "@lpshanley/oidc-start-core/models";
import { OidcAuthProvider, SignedIn, SignedOut, useAuth, useUser } from "./client.js";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("./functions.js", () => ({ signOut: vi.fn(), getSignInUrl: vi.fn() }));

const member = { sub: "1", email: "member@example.com", name: null, roles: ["member"] };

function render(user: AuthUser | null, children: ReactNode) {
	return renderToStaticMarkup(createElement(OidcAuthProvider, { auth: { user }, children }));
}

test("useUser reads the SSR identity and requires a provider", () => {
	function Identity() {
		return useUser()?.sub ?? "guest";
	}
	expect(render(member, createElement(Identity))).toBe(member.sub);
	expect(render(null, createElement(Identity))).toBe("guest");
	expect(() => renderToStaticMarkup(createElement(Identity))).toThrow("OidcAuthProvider");
});

test("the signed-in and signed-out components render complementary UI during SSR", () => {
	const menu = createElement("nav", null,
		createElement(SignedIn, { children: "account" }),
		createElement(SignedOut, { children: "sign in" }),
	);
	expect(render(member, menu)).toBe("<nav>account</nav>");
	expect(render(null, menu)).toBe("<nav>sign in</nav>");
});

test("the hook checks roles against the loader's user, including older sessions", () => {
	function Menu() {
		return useAuth().hasRole("member") ? "account" : "public";
	}
	expect(render(member, createElement(Menu))).toBe("account");
	expect(render({ ...member, roles: undefined }, createElement(Menu))).toBe("public");
	expect(render(null, createElement(Menu))).toBe("public");
});
