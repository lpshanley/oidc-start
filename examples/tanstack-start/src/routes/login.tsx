import { authErrorMessage } from "@lpshanley/oidc-start-react";
import { useAuth } from "@lpshanley/oidc-start-react/client";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/login")({
	validateSearch: (search): { auth_error?: unknown } => ({ auth_error: search.auth_error }),
	component: Login,
});

function Login() {
	const { auth_error } = Route.useSearch();
	const navigate = Route.useNavigate();
	const { signIn } = useAuth();

	function dismissError() {
		return navigate({
			search: previous => ({ ...previous, auth_error: undefined }),
			hash: true,
			replace: true,
			resetScroll: false,
		});
	}

	return (
		<main>
			<h1>Sign in</h1>
			{auth_error !== undefined && (
				<>
					<p role="alert">{authErrorMessage(auth_error)}</p>
					<button onClick={dismissError}>Dismiss</button>
				</>
			)}
			<button onClick={() => signIn()}>Sign in</button>
		</main>
	);
}
