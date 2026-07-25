# Local OIDC provider

A throwaway identity provider for developing Roadie's `-auth=oidc` mode, so you
don't need a real Entra tenant. Configuration only — the image is
[`soluto/oidc-server-mock`](https://github.com/Soluto/oidc-server-mock)
(IdentityServer under the hood).

Everything it needs is in this directory: its own `compose.yaml` (a separate
compose project) and its own `Makefile`. The repository's root `compose.yaml`
and `Makefile` know nothing about it, so the normal dev path — `make db-up`,
`make dev`, `make docker-up` — never starts, stops or waits on it.

```sh
make -C dev/oidc up     # start it (http://localhost:4011)
make dev-oidc           # run Roadie against it on http://localhost:8080
make -C dev/oidc down   # stop it
```

The Makefile here only starts and stops the provider. Running Roadie against it
is the root Makefile's `dev-oidc` rule, whose `OIDC_ISSUER`, `OIDC_CLIENT_ID`
and `OIDC_CLIENT_SECRET` defaults match the values configured here.

With both running, `./login-test.sh` walks a complete authorization code flow —
login form, callback, session, an authenticated mutation, CSRF, logout — and
checks that the API reports the right person. It reads credentials and expected
claims from `users.json`, so editing that file cannot leave it asserting
something stale. Nothing else covers this: the Go tests cannot do a real OIDC
round trip. But note what it *cannot* tell you — see below.

Sign in as one of the users defined in [`users.json`](users.json).

JSON has no comments, so the deliberate choices live here.

## HTTP only, no TLS

The upstream image can serve HTTPS with a self-signed certificate. We
deliberately don't: the browser is redirected to the provider directly, so it
applies its own trust store and parks on a certificate interstitial. No
server-side setting can prevent that — Roadie's `-oidc-insecure-tls` relaxes
only Roadie's own client (discovery and the token exchange), never the browser's
connection. Plain HTTP on localhost sidesteps the whole problem.

Serving HTTP does mean the `SERVER_OPTIONS_INLINE` override in `compose.yaml`
is load-bearing rather than cosmetic: by default the provider marks its session
cookies `SameSite=None`, which browsers only accept together with `Secure`, and
`Secure` needs HTTPS. Left alone, the browser drops the session cookie, the
authorize step sees no login, and the form reappears forever. Note that curl
does not implement SameSite at all, so scripted flows pass either way — this is
a bug only a real browser can find.

## Claims come from UserInfo, not the ID token

IdentityServer puts identity claims in the UserInfo response unless a client
sets `AlwaysIncludeUserClaimsInIdToken`. Entra inlines them in the ID token
instead. We leave the default alone on purpose: it means local development
exercises Roadie's UserInfo fallback, which is the path that would otherwise
only ever run in production, and only if a provider changed its behaviour. It
already caught one bug where the display name silently degraded to an opaque
subject id.

## Trimmed to what Roadie uses

- One grant type, `authorization_code`, with PKCE required. Roadie keeps no
  refresh token (it calls no downstream API), so `offline_access` and
  `AllowOfflineAccess` are gone.
- `RequireClientSecret` is on, matching Roadie's registration in Entra as a
  confidential *Web* client rather than a public SPA.
- Scopes are `openid profile email` — exactly what Roadie requests.
- No `PostLogoutRedirectUris`: logout is local, so RP-initiated logout is never
  triggered.

## Stuck on the login form?

Submitting valid credentials and landing back on the same page, with no error,
means the browser is not keeping the provider's session cookie. Check its
attributes — see the `SameSite` note above, which is the usual cause.

## Changing the port

`RedirectUris` lists only `http://localhost:8080/auth/callback`, the address
`make dev-oidc` serves on. If you override `OIDC_ADDR`, add the matching URI
here and restart (`make -C dev/oidc down up`) — the provider matches it exactly.
Likewise, the client id and secret here have to match the root Makefile's
`OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` defaults.
