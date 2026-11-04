import { handleCallbackRoute } from "@lpshanley/oidc-start-react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/callback")({
	server: { handlers: {
		GET: handleCallbackRoute({
			onError: ({ reason }) => new Response(null, {
				status: 303,
				headers: {
					Location: "/login?" + new URLSearchParams({ auth_error: reason }),
					"Cache-Control": "no-store",
				},
			}),
		}),
	} },
});
