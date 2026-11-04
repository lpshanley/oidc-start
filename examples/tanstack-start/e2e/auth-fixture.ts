// Copied into the disposable packed consumer only; never used by the example app.
import { createOidcCore, createMemorySessionRegistry } from "@lpshanley/oidc-start-react/server";
const registry = createMemorySessionRegistry();
const subjects = new Map<string, string>();
const admitted = new Set<string>();
export const auth = createOidcCore({
  cookiePrefix: "example", callbackPath: "/callback", postLogoutPath: "/",
  registry: {
    ...registry,
    async register(session) { await registry.register(session); subjects.set(session.sid, session.sub); },
    async isActive(session) {
      if (subjects.get(session.sid) === "store-down") throw new Error("Fixture registry unavailable");
      return registry.isActive(session);
    },
  },
  allowSession(user) {
    if (user.sub !== "denied-after-login") return true;
    if (admitted.has(user.sub)) return false;
    admitted.add(user.sub); return true;
  },
});
