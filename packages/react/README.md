# @lpshanley/oidc-start-react

Add OpenID Connect sign-in to a TanStack Start app. Loaders can read the current user, components can start sign-in or sign-out, and Start’s middleware handles the session cookies. The code exchange and provider tokens stay on the server.

This guide adds two routes to an existing app. The home page at `/` shows who is signed in. The callback at `/callback` receives the browser when the provider sends it back. [Complete example app](https://github.com/lpshanley/oidc-start/tree/main/examples/tanstack-start)

For multi-replica deployment, see the [production guide](https://github.com/lpshanley/oidc-start/blob/main/docs/production.md) and [tested PostgreSQL example](https://github.com/lpshanley/oidc-start/tree/main/examples/postgres).

## 1. Install and configure the server

Use Node.js 22.12 or newer. Your app supplies `@tanstack/react-start@^1.169.2` and `@tanstack/react-router@^1.170.44`. Install the React adapter. It brings in the OIDC core as a dependency.

```sh
npm install @lpshanley/oidc-start-react
```

Register a confidential web client with your OIDC provider. If your app runs at `http://localhost:5173`, register these exact URLs. Use your public HTTPS origin in production.

| Provider setting | Local value |
| --- | --- |
| Sign-in redirect URI | `http://localhost:5173/callback` |
| Post-logout redirect URI | `http://localhost:5173/` |

Set these values in your **server environment**. Generate `SESSION_SECRET` once with `openssl rand -hex 32` and reuse it across server instances. Your provider must supply the account’s email in the ID token or through UserInfo.

```dotenv
APP_ORIGIN=http://localhost:5173
OIDC_ISSUER=https://id.example.com
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
# Paste the generated secret here before starting the app.
SESSION_SECRET=
```

Import `createOidcCore` and the `SessionRevocations` type from `@lpshanley/oidc-start-react/server` in your server module. For local development, copy the example’s `auth.server.ts` into `src/auth.server.ts`. It exports an `auth` instance configured with `callbackPath: '/callback'` and `postLogoutPath: '/'`. The example admits any authenticated user and keeps revocations in memory. For deployment, set `allowSession` to your access policy and use a durable revocation store shared by all instances. [Copy auth.server.ts](https://github.com/lpshanley/oidc-start/blob/main/examples/tanstack-start/src/auth.server.ts) · [Core configuration and storage](https://www.npmjs.com/package/@lpshanley/oidc-start-core)

## 2. Register the request middleware

In `src/start.ts`, add Start’s CSRF middleware before the OIDC middleware. The first checks the origin of browser calls to server functions, including sign-out. The second resolves the session for the request and writes any refreshed cookies. The `createServerOnlyFn` wrapper keeps your `auth` instance out of the client bundle.

```ts
import { oidcMiddleware } from '@lpshanley/oidc-start-react'
import { createCsrfMiddleware, createServerOnlyFn, createStart } from '@tanstack/react-start'
import { auth } from './auth.server'

const csrf = createCsrfMiddleware({ filter: ctx => ctx.handlerType === 'serverFn' })
const oidc = oidcMiddleware({ core: createServerOnlyFn(() => auth) })

export const startInstance = createStart(() => ({
  requestMiddleware: [csrf, oidc],
}))
```

## 3. Add the callback route

Create `src/routes/callback.ts`. The handler checks the provider response, establishes the session, and redirects to the local path chosen at sign-in.

```ts
import { handleCallbackRoute } from '@lpshanley/oidc-start-react'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/callback')({
  server: { handlers: { GET: handleCallbackRoute() } },
})
```

## 4. Connect the buttons

In `src/routes/index.tsx`, call `getAuth()` from the loader. It returns `{ user }`, with `user: null` for a signed-out visitor. Bind `signOut` with `useServerFn` so TanStack follows the redirect to the provider when the user clicks the button.

```tsx
import { displayName } from '@lpshanley/oidc-start-react'
import { getAuth, getSignInUrl, signOut } from '@lpshanley/oidc-start-react/functions'
import { createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

export const Route = createFileRoute('/')({
  loader: () => getAuth(),
  component: Home,
})

function Home() {
  const { user } = Route.useLoaderData()
  const signOutAndRedirect = useServerFn(signOut)

  if (!user) {
    return <button onClick={async () => location.assign(await getSignInUrl())}>Sign in</button>
  }

  return (
    <main>
      <p>Signed in as {displayName(user)}.</p>
      <button onClick={() => signOutAndRedirect()}>Sign out</button>
    </main>
  )
}
```

For shared UI such as an account menu, load `getAuth()` in the root route and wrap `<Outlet />` in `<OidcAuthProvider auth={Route.useLoaderData()}>`. Import the provider and `useAuth` from `@lpshanley/oidc-start-react/client`. Components can then call `const { user, signIn, signOut } = useAuth()` and bind buttons with `onClick={() => signIn()}` or `onClick={() => signOut()}`. The first render uses the loader's user, and subsequent loader updates flow through the provider. [Example root route](https://github.com/lpshanley/oidc-start/blob/main/examples/tanstack-start/src/routes/__root.tsx)

Call `signOut()` for the current session or `signOut({ everywhere: true })` for all of this user's sessions in this app. Both use the same CSRF-protected POST server function. If the revocation store is unavailable, the server returns 503 so the user can retry.

Use `useAuth().hasRole('admin')` to show role-specific UI. It returns false for signed-out users and sessions without a roles claim. Check authorization again in the server handler that reads private data or performs the action.

Import `useUser` from `@lpshanley/oidc-start-react/client` when a component only needs the loader's `AuthUser | null`.

**Try it.** Open `/` in a fresh browser session and choose **Sign in**. After the provider redirects you back, your name should appear and survive a reload. Choose **Sign out**, finish logout at the provider if prompted, and reload. You should see **Sign in** again.

To return someone to a specific page, pass a local path when starting sign-in, for example `getSignInUrl({ data: { returnPathname: '/account' } })`.

To prefill an account, pass `loginHint`. For an account picker, call `signIn({ prompt: 'select_account' })`. The hook, `getSignInUrl({ data: options })`, and `handleSignInRoute(options)` accept the same sign-in options. Supported prompts are `login`, `consent`, `select_account`, and `none`. Omitting `prompt` leaves the provider's usual SSO behavior in place.

## HTTP routes and server access

The buttons above use server functions. If you prefer ordinary links and forms, mount these handlers from `@lpshanley/oidc-start-react` behind the same OIDC middleware. Choose the paths in your app.

| Method | Handler | When to use it |
| --- | --- | --- |
| GET | `handleSignInRoute()` | Link to sign-in. The optional `returnPathname` query parameter selects a local return path. |
| GET | `handleCallbackRoute()` | Mount at the exact callback path registered with your provider. |
| POST | `handleSignOutRoute()` | Submit a same-origin form. Add `server.middleware: [createCsrfMiddleware()]` to this route because the global filter above only covers server functions. |
| POST | `handleBackchannelLogoutRoute()` | Register this URL with your provider for back-channel logout. The provider sends a signed logout token without a browser Origin header. Keep the browser CSRF check scoped to the browser routes. |

In a server handler, import `getOidcContext` from `@lpshanley/oidc-start-react/server` to access the resolved session and core for the current request. Use `getAuth()` from `/functions` when a loader or component only needs the user.

### Customize callback failures

Pass `onError({ reason, request })` to `handleCallbackRoute` to return a custom response. It takes precedence over `errorRedirectUrl`. A provider cancellation is `access_denied`, and a missing verifier (for example after its cookie expires) is `sign_in_expired`. Other reasons are `invalid_callback`, `invalid_state`, `provider_error`, `token_exchange_failed`, and `session_failed`. The middleware still clears the failed flow's verifier. A rejection by your own `allowSession` policy takes its separate 403 path.

### Require a recent login

Inside the server handler for a sensitive action, call `checkRecentAuth({ maxAge: 300 })` from `@lpshanley/oidc-start-react/server` before performing the action. If `isStale` is true, stop the mutation and offer `signIn({ maxAge: 300, returnPathname: '/settings' })`. Check again when the user submits the action after returning. Pick the maximum age in the server's policy.

The age is in seconds and comes from the provider's ID-token `auth_time`. Signed-out users, existing sessions without that claim, and expired authentication all require sign-in. Token refresh preserves the original authentication time. A sign-in with `maxAge: 0` requests fresh authentication.
