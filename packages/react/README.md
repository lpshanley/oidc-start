# @lpshanley/oidc-start-react

TanStack Start for React bindings for `@lpshanley/oidc-start-core`. Install alongside the application's React Start and React Router packages.

Register `oidcMiddleware({ core: () => auth })` in Start's request middleware. Here `auth` is the server-side core configured by the host. You can also read a core from the context supplied by earlier server middleware. In a file shared with the browser, load server-only composition inside the server boundary.
