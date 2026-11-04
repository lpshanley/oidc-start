import { requireAuth } from "@lpshanley/oidc-start-react/functions";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/account")({
	beforeLoad: ({ location }) => requireAuth({ signInPath: "/sign-in", returnPathname: location.href }),
	component: Account,
});

function Account() {
	const { user } = Route.useRouteContext();
	return <p>Account for {user.email}</p>;
}
