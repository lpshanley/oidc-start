import { AuthProvider } from "@lpshanley/oidc-start-react/client";
import { getAuth } from "@lpshanley/oidc-start-react/functions";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";

export const Route = createRootRoute({
	loader: () => getAuth(),
	component: Root,
});

function Root() {
	const auth = Route.useLoaderData();
	return (
		<html lang="en">
			<head><HeadContent /></head>
			<body><AuthProvider auth={auth}><Outlet /></AuthProvider><Scripts /></body>
		</html>
	);
}
