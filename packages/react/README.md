# @lpshanley/oidc-start-react

TanStack Start for React bindings for `@lpshanley/oidc-start-core`. Install alongside the application's React Start and React Router packages.

Register `oidcMiddleware({ core: () => auth })` in Start's request middleware. Here `auth` is the server-side core configured by the host. You can also read a core from the context supplied by earlier server middleware. In a file shared with the browser, load server-only composition inside the server boundary.

```ts
import { createFileRoute } from '@tanstack/react-router'
import { handleCallbackRoute } from '@lpshanley/oidc-start-react'

export const Route = createFileRoute('/auth/callback')({
  server: { handlers: { GET: handleCallbackRoute() } },
})
```

Register `handleSignInRoute()` on GET and `handleSignOutRoute()` and `handleBackchannelLogoutRoute()` on POST. Configure the back-channel route to accept authenticated provider logout requests without a browser Origin header. Keep browser CSRF protection on sign-out.
