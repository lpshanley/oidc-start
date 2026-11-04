import { handleCallbackRoute } from "@lpshanley/oidc-start-react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/callback")({
	server: { handlers: { GET: handleCallbackRoute() } },
});
