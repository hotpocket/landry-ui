# sso-gate

Google sign-in plus an Admin-managed allow-list, for any landry.bot site with an
API. Extracted from resume.landry.bot, which is the reference consumer.

- **Allow-list** — the Google account emails permitted to sign in. Lives in the
  site's store (DynamoDB in prod), managed by the Admin from the UI; no redeploy
  to invite someone. Env lists (`ALLOWED_EMAILS`, `ALLOWED_DOMAIN`) are a
  bootstrap that is always allowed too. Everything empty = open to any Google
  account.
- **Admin** — the one account (`ADMIN_EMAIL`) that may manage the allow-list.

No Google client id = local dev: verification is skipped and every request is a
fixed dev user, who is also the Admin.

| Part | What | Consumed by |
|---|---|---|
| `server/` | Express gate middleware, `/me` + `/allowlist` routes, file and DynamoDB stores | `luinst sso-gate/server <api>/src/vendor/sso-gate` (committed; see below) |

## Server

```ts
import { createSsoGate, ssoConfigFromEnv } from './vendor/sso-gate/index.js';
import { DynamoAllowListStore } from './vendor/sso-gate/dynamo.js';

const env = ssoConfigFromEnv();               // GOOGLE_CLIENT_ID, ADMIN_EMAIL, ALLOWED_EMAILS, ALLOWED_DOMAIN, DEV_USER_SUB
const gate = createSsoGate({ ...env, store: new DynamoAllowListStore(docClient, process.env.DDB_TABLE!) });
app.use('/api', healthRouter);                // public routes first
app.use('/api', gate.requireAuth);            // 401 no/bad token, 403 not allowed; sets req.user {sub,email,name?}
app.use('/api', gate.router);                 // GET /me, GET|POST /allowlist, DELETE /allowlist/:email
```

Peer libraries the site provides: `express`, `zod`, `google-auth-library`, and
(for `dynamo.ts` only) `@aws-sdk/lib-dynamodb`. A site's own store may implement
`AllowListStore` (three methods) instead of using the ones here.

HTTP contract (the client half depends on it):

| Request | Answer |
|---|---|
| any, no `Authorization: Bearer` | `401 {error:"missing bearer token"}` |
| token Google rejects | `401 {error:"token verification failed"}` — the client refreshes once and retries |
| signed in, not allowed | `403 {error:"account not authorized for this app"}` — the client shows "by invitation only" |
| `GET /me` | `{email, name?, isAdmin}` |
| `GET /allowlist` (Admin) | `{emails:[…]}` sorted, lowercase; non-Admin `403 {error:"admin only"}` |
| `POST /allowlist {email}` (Admin) | `{emails}`; bad email `400` |
| `DELETE /allowlist/:email` (Admin) | `{emails}`; absent `404` |

## Vendoring

npm cannot install a subdirectory of a git repo, so TypeScript halves are
vendored: `luinst` copies the directory and writes a `.luinst` stamp naming the
landry-ui commit. Commit the copy (the API's tests and Lambda bundling need it
offline); re-run `luinst` to update, never edit it in place.

## Tests

```sh
cd sso-gate && npm install && npm run typecheck && npm test
```
