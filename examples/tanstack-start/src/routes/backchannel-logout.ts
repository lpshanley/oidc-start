import { createFileRoute } from "@tanstack/react-router";
import { handleBackchannelLogoutRoute } from "@lpshanley/oidc-start-react";

export const Route = createFileRoute("/backchannel-logout")({
	server: { handlers: { POST: handleBackchannelLogoutRoute() } },
});
