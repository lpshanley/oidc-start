# @lpshanley/oidc-start-core

OpenID Connect sign-in for Node.js servers. Give the core a standard `Request` and it handles provider discovery, the authorization code exchange with PKCE, and sealed session cookies. Your app decides who can sign in and where to record revoked sessions.

Building a TanStack Start app? The React adapter connects the core to Start’s request middleware, routes, and server functions. [TanStack Start quickstart](https://www.npmjs.com/package/@lpshanley/oidc-start-react)

## Install and register your app

Use Node.js 22.12 or newer with ES modules. Install the current prerelease from npm.

```sh
npm install @lpshanley/oidc-start-core@next
```

Register a **confidential web client** with your OIDC provider. For the example below, register `http://localhost:5173/callback` as the sign-in redirect URI and `http://localhost:5173/` as the post-logout redirect URI. In production, use your app’s public HTTPS origin for both.

| Server setting | What to supply |
| --- | --- |
| `APP_ORIGIN` | The public origin of your app, such as `http://localhost:5173` in development. |
| `OIDC_ISSUER` | The provider’s issuer URL, including its tenant path if it has one. |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | The credentials issued to your web client. |
| `SESSION_SECRET` | Generate once with `openssl rand -hex 32`. Keep the same secret across restarts and server instances. |
| `OIDC_SCOPES` | Optional. Defaults to `openid profile email offline_access`. The provider must supply an email in the ID token or through UserInfo. |
| `OIDC_ROLES_CLAIM` | Optional. Defaults to `roles`. If the ID token omits this claim, the core checks UserInfo when the provider advertises it. Without either source, your policy receives an empty role list. |

## Create the core

Create one instance in a server module. This example requires the `members` role, so give your test user that role at the provider. The core checks the policy at sign-in, when reading a session, and after refreshing it.

```ts
// auth.server.ts
import { createOidcCore } from '@lpshanley/oidc-start-core'
import { hasRole } from '@lpshanley/oidc-start-core/models'
import { revocations } from './revocations.js'

export const auth = createOidcCore({
  cookiePrefix: 'myapp',
  callbackPath: '/callback',
  postLogoutPath: '/',
  allowSession: user => hasRole(user, 'members'),
  revocations,
})

auth.assertConfigured()
```

`./revocations.js` is an app module you supply. For a local trial, copy the three maps and the `revocations` object from the example into `revocations.ts` and export the object. A deployed app needs durable storage shared by every instance. [Local revocation store](https://github.com/lpshanley/oidc-start/blob/main/examples/tanstack-start/src/auth.server.ts)

## Wire sign-in and callback

Mount these handlers at `GET /sign-in` and `GET /callback` in your server. The first sends the browser to the provider. The second checks the code and browser verifier, sets the session cookie, and returns the user to `/`.

```ts
import { SessionAccessDeniedError } from '@lpshanley/oidc-start-core'
import { auth } from './auth.server.js'

function authHeaders(cookies: string[]) {
  const headers = new Headers({ 'Cache-Control': 'no-store' })
  for (const cookie of cookies) headers.append('Set-Cookie', cookie)
  return headers
}

export async function signIn(request: Request) {
  const { cookies, setCookies } = await auth.resolve(request)
  const flow = await auth.signIn(request, cookies, '/')
  const headers = authHeaders([...setCookies, ...flow.setCookies])
  headers.set('Location', flow.url)
  return new Response(null, { status: 302, headers })
}

export async function callback(request: Request) {
  const { cookies, setCookies } = await auth.resolve(request)
  const result = await auth.callback(request, cookies)
  const headers = authHeaders([...setCookies, ...result.setCookies])
  if (!result.ok) {
    const denied = result.error instanceof SessionAccessDeniedError
    return new Response(denied ? 'Access denied.' : 'Please sign in again.', {
      status: denied ? 403 : 400, headers,
    })
  }
  headers.set('Location', result.location)
  return new Response(null, { status: 302, headers })
}
```

On an ordinary request, `const { session, setCookies } = await auth.resolve(request)` gives you `session?.user`. Forward **each** returned `Set-Cookie` header separately, even on a signed-out response. A read can refresh a session or clear an expired cookie. Keep the full session on the server because it contains provider tokens. Browser code can use `AuthUser`, `displayName`, and `hasRole` from `@lpshanley/oidc-start-core/models`.

## End a session

For browser sign-out, use a same-origin, CSRF-protected POST handler. Resolve the request, pass its `cookies` and `session` to `auth.signOut(request, cookies, session)`, append both sets of cookies as above, and redirect with **303** to the returned `location`. If recording the revocation throws, return a retryable error. The default session lasts up to 14 days and expires after 12 hours of inactivity.

Implement these four methods on your `SessionRevocations` store. All times are in epoch seconds. Let storage errors propagate so the core can distinguish an outage from an active session.

| Method | Storage rule |
| --- | --- |
| `revoke(sid, until)` | Mark this app session as revoked through its expiry. |
| `revokeIdpSession(idpSid, until)` | Mark the provider session as revoked. Atomically keep the later expiry. |
| `revokeAllFor(sub, cutoff)` | Atomically keep the greatest cutoff for the subject. |
| `isRevoked({ sid, idpSid, sub, issuedAt })` | Return true for a live revocation of either session ID, or when `issuedAt <= cutoff` for this subject. |

For provider-initiated logout, register a POST endpoint and pass its request to `auth.backchannelLogout(request)`. Return the resulting HTTP status to the provider. The core verifies the signed logout token, including its expiry and nonempty token ID. A redelivered event uses the original issue time. [Revocation interface](https://github.com/lpshanley/oidc-start/blob/main/packages/core/src/revocation.ts)

## Obtain a separate provider grant

Use this flow when your app needs credentials for provider API calls independently of the browser session. Register a second redirect URI with the provider. The default path is `/api/auth/grant-callback`, configurable with `grantCallbackPath`.

1. Call `auth.startGrant(request, cookies, returnPathname)`, send its cookies, and redirect to its `url`.
2. In the grant callback, call `auth.finishGrant(request, cookies)` and forward its cookies on success or failure. On success, check the returned user and permissions before storing the tokens on the server.
3. Call `auth.refreshGrant(refreshToken)` to renew the grant. A `refused` result means the provider rejected it. Other errors propagate. `RefreshNotDispatched` from `@lpshanley/oidc-start-core/provider` means the refresh request was never sent.
