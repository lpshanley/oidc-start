import { requireRecentAuth } from "@lpshanley/oidc-start-react/functions";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({
	beforeLoad: ({ location }) => requireRecentAuth({ signInPath: "/sign-in", returnPathname: location.href, maxAge: 300 }),
	component: () => <h1>Account settings</h1>,
});
