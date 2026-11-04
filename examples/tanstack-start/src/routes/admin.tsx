import { hasRole } from "@lpshanley/oidc-start-react";
import { requireAuth } from "@lpshanley/oidc-start-react/functions";
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/admin")({
	beforeLoad: async ({ location }) => {
		const { user } = await requireAuth({ signInPath: "/sign-in", returnPathname: location.href });
		if (!hasRole(user, "admin")) throw redirect({ href: "/forbidden", reloadDocument: true });
		return { user };
	},
	component: () => <h1>Admin dashboard</h1>,
});
