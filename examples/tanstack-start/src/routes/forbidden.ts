import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/forbidden")({
	server: { handlers: {
		GET: () => new Response("You need the admin role to view this page.", {
			status: 403,
			headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
		}),
	} },
});
