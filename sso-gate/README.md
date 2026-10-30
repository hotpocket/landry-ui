# sso-gate

Sign-in for any landry.bot site, through the landry.bot identity broker
(`auth.landry.bot`: one Cognito pool with Google as its only identity provider;
source in hotpocket/landry-auth). No per-site step in Google's console.

- **Allow-list**: central, per site, in the broker. The broker's pre-token
  check refuses a sign-in (and every token refresh) unless the email is on
  that site's list, so a site never sees a token for someone who is not.
  One item per (site, email); every change is conditional on that one member,
  so two admins editing at once cannot undo each other.
- **Roles**: `admin` (manages that site's list) or `user`. Global admins
  (sirjava@gmail.com) are admin on every site and cannot be removed through a site.
- **Site key**: the app client's name in the pool (`graph`, `resume`, `books`,
  `family`). Tokens carry `landry_site` and `landry_role`.
- Removing someone blocks their next sign-in and token refresh at once; an
  access token issued before the removal stays valid until it expires (at most an hour).

| Part | What | Consumed by |
|---|---|---|
| `cdk/` | `LandrySiteClient`: the site's app client in the broker pool; sets `LANDRY_*` on the API function | `luinst sso-gate/cdk <infra>/lib/vendor/sso-gate` (committed) |
| `server/` | Express gate: verifies the Cognito **access** token for this site, `GET /me` | `luinst sso-gate/server <api>/src/vendor/sso-gate` (committed) |
| `flutter/` | `sso_gate` Dart package: `SsoAuth` (PKCE redirect), `SsoGateScreen`, `MembersDialog` | pubspec git dependency |
| `js/` | `landry-auth.js`: the same client for plain-JS pages, plus `mountMembersAdmin` | copy the file (luinst) and serve it |

## Infrastructure (CDK)

```ts
import { LandrySiteClient } from './vendor/sso-gate';

const auth = new LandrySiteClient(this, 'Auth', {
  site: 'graph',
  callbackUrls: ['https://graph.landry.bot/', 'http://localhost:8080/'],
  api: apiFn,                       // gets LANDRY_SITE, LANDRY_USER_POOL_ID, LANDRY_CLIENT_ID
  allowAdminTestAuth: true,         // optional: deploy smoke tests mint tokens with IAM creds
});
new cdk.CfnOutput(this, 'AuthClientId', { value: auth.clientId });   // the web build needs it
```

The pool id, hosted domain and API URL come from the broker's SSM exports
(`/landry/auth/*`, landry account, us-east-1) at deploy time. Same-account
sites only; a site in another account (books) gets its client from the
landry-auth stack. Peer libraries: `aws-cdk-lib`, `constructs`.

## Server

```ts
import { createSsoGate, ssoConfigFromEnv } from './vendor/sso-gate/index.js';

const gate = createSsoGate(ssoConfigFromEnv());   // LANDRY_SITE, LANDRY_USER_POOL_ID, LANDRY_CLIENT_ID; AUTH=off (outside Lambda only)
app.use('/api', healthRouter);                     // public routes first
app.use('/api', gate.requireAuth);                 // sets req.user {sub, email, role, site, googleSub?}
app.use('/api', gate.router);                      // GET /me -> {email, role, isAdmin, site}
app.post('/api/x', gate.requireAdmin, ...);
```

Fails closed: no pool or client id means every request is 401. `googleSub` is
the Google account id behind the sign-in, for sites whose data was keyed on
the Google ID token's `sub` before the broker. Peer libraries: `express`,
`aws-jwt-verify`.

| Request | Answer |
|---|---|
| no `Authorization: Bearer` | `401 {error:"missing bearer token"}` |
| bad signature / expired / ID token / another site's client | `401 {error:"token verification failed"}`: the client refreshes once and retries |
| token stamped for another site, or not stamped | `403 {error:"account not authorized for this app"}` |
| `requireAdmin`, not admin | `403 {error:"admin only"}` |

## Broker API (managing a site's users)

`https://api.auth.landry.bot`, bearer = the site's access token. Authority
comes from the table, not the token.

| Request | Answer |
|---|---|
| `GET /me` | `{email, global, sites:{site: role}}` |
| `GET /sites/{site}/members` | `{members:[{email, role, global, addedBy, addedAt}]}` (site admin) |
| `POST /sites/{site}/members {email, role?}` | `201`, `409` already a member |
| `PATCH /sites/{site}/members/{email} {role}` | `200`, `404`, `409` yourself |
| `DELETE /sites/{site}/members/{email}` | `204`, `404`, `409` yourself |

## Browser flow (Flutter and JS alike)

`signIn()` goes to `https://auth.landry.bot/oauth2/authorize` with
`identity_provider=Google` (straight to Google, no Cognito page) and PKCE.
Back on the site, `init()` exchanges the code, cleans the URL and returns to
the page the user left. Refused by the allow-list = status `denied`. Tokens
live in localStorage under `landry.<site>.auth`; the PKCE verifier in
sessionStorage. Every storage touch is in a try: iOS Safari with "Block All
Cookies" throws from the storage getter, and the page must still render a
sentence (sign-in itself needs cookies there and cannot work).

```js
const auth = LandryAuth.create({ site: 'books', clientId });
const s = await auth.init();         // checking -> signedIn | signedOut | denied | error
if (s.status === 'signedIn') await auth.fetch('/api/library');
if (s.user.isAdmin) LandryAuth.mountMembersAdmin(el, auth);
```

## Vendoring

npm cannot install a subdirectory of a git repo, so the TypeScript halves are
vendored: `luinst` copies the directory and writes a `.luinst` stamp naming the
landry-ui commit. Commit the copy; re-run `luinst` to update, never edit it.

## Tests

```sh
cd sso-gate && npm install && npm run typecheck && npm test   # server + cdk + js
cd sso-gate/flutter && flutter test && flutter analyze          # Flutter client
```
