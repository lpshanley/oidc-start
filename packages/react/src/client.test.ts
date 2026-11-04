import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import type { AuthUser } from "@lpshanley/oidc-start-core/models";
import { signOut } from "./functions.js";
import { AuthProvider, SignedIn, SignedOut, useAuth, useUser } from "./client.js";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("./functions.js", () => ({ signOut: vi.fn(), getSignInUrl: vi.fn() }));

const member = { issuer: "https://idp.test/application/o/sage/", sub: "1", email: "member@example.com", name: null, roles: ["member"] };

function render(user: AuthUser | null, children: ReactNode) {
	return renderToStaticMarkup(createElement(AuthProvider, { auth: { user }, children }));
}

test("useUser reads the SSR identity and requires a provider", () => {
	function Identity() {
		return useUser()?.sub ?? "guest";
	}
	expect(render(member, createElement(Identity))).toBe(member.sub);
	expect(render(null, createElement(Identity))).toBe("guest");
	expect(() => renderToStaticMarkup(createElement(Identity))).toThrow("AuthProvider");
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

 test("signOut forwards options without serializing a React event", () => {
  let logout: ReturnType<typeof useAuth>["signOut"];
  function Capture() { logout = useAuth().signOut; return null; }
  render(member, createElement(Capture));
  logout!({ everywhere: true, providerLogout: false });
  expect(signOut).toHaveBeenLastCalledWith({ data: { everywhere: true, providerLogout: false } });
  const event = { nativeEvent: { target: null } };
  Object.assign(event.nativeEvent, { target: event });
  logout!(event as never);
  expect(signOut).toHaveBeenLastCalledWith({ data: { everywhere: false, providerLogout: undefined } });
});
