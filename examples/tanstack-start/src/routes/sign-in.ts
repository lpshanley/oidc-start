import { handleSignInRoute } from "@lpshanley/oidc-start-react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-in")({
	server: { handlers: { GET: handleSignInRoute() } },
});
