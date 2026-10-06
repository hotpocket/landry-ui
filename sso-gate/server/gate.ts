/**
 * THE GATE. The browser signs in with Google and sends the Google ID token
 * (a JWT) as `Authorization: Bearer <idToken>` on every API call. We verify
 * its signature + audience against Google, check the email against the
 * allow-list, and expose the stable user id (`sub`) as req.user.
 *
 * Allow-list = bootstrap env lists (emails, one domain) OR the store-backed
 * list the Admin manages in the UI. Open to any Google account only when every
 * source is empty.
 *
 * No Google client id => local dev: verification is skipped and every request
 * is one fixed dev user, who is also the Admin.
 */

import { OAuth2Client } from 'google-auth-library';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { AllowListStore } from './store.js';

export interface SsoUser {
  /** Google's stable, unique subject id — the data partition key. */
  sub: string;
  email: string;
  name?: string;
}

// Augment Express Request so handlers can read req.user with types.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SsoUser;
    }
  }
}

/** The verified claims the gate reads from a Google ID token. */
export interface IdTokenClaims {
  sub?: string;
  email?: string;
  /** Google proved the account owns `email`; anything but true is refused. */
  email_verified?: boolean;
  /** Google Workspace hosted domain. */
  hd?: string;
  name?: string;
}

/** Verifies an ID token for `audience`; throws when Google says no. */
export type IdTokenVerifier = (idToken: string, audience: string) => Promise<IdTokenClaims | undefined>;

export interface SsoGateOptions {
  /** Google OAuth Web client id. Empty => auth disabled (local dev). */
  googleClientId: string;
  /** The one account that manages the allow-list. Empty => nobody. */
  adminEmail?: string;
  /** Bootstrap emails, allowed regardless of the store. */
  allowedEmails?: Iterable<string>;
  /** Bootstrap Google Workspace / email domain. */
  allowedDomain?: string;
  store: AllowListStore;
  /** Local dev: impersonate this Google sub instead of 'local-dev'. */
  devUserSub?: string;
  /** Test seam; defaults to google-auth-library. */
  verifyIdToken?: IdTokenVerifier;
  /** Where rejection reasons go; defaults to console.warn (CloudWatch). */
  log?: (line: string) => void;
}

export interface SsoGate {
  readonly authDisabled: boolean;
  /** Rejects requests without a valid, allow-listed token; sets req.user. */
  readonly requireAuth: RequestHandler;
  /** 403 unless req.user is the Admin; mount after requireAuth. */
  readonly requireAdmin: RequestHandler;
  /** GET /me, GET|POST /allowlist, DELETE /allowlist/:email. Mount after requireAuth. */
  readonly router: Router;
  isAdmin(user: SsoUser): boolean;
  emailAllowed(email: string, hostedDomain?: string): Promise<boolean>;
}

/**
 * The allow decision on its own: env lists OR the store; open only when all
 * three are empty.
 */
export async function emailAllowed(
  email: string,
  hostedDomain: string | undefined,
  store: AllowListStore,
  env: { emails: ReadonlySet<string>; domain: string },
): Promise<boolean> {
  if (env.emails.has(email.toLowerCase())) return true;
  if (env.domain) {
    const domain = (hostedDomain ?? email.split('@')[1] ?? '').toLowerCase();
    if (domain === env.domain) return true;
  }
  const stored = await store.listAllowedEmails();
  if (stored.includes(email.toLowerCase())) return true;
  // Open mode: no source configured at all.
  return env.emails.size === 0 && !env.domain && stored.length === 0;
}

function googleVerifier(clientId: string): IdTokenVerifier {
  const client = new OAuth2Client(clientId);
  return async (idToken, audience) => (await client.verifyIdToken({ idToken, audience })).getPayload();
}

/** Best-effort unverified claim peek for diagnostics only — never for auth. */
function decodeUnverified(jwt: string): { aud?: string; exp?: number } | null {
  try {
    const payload = jwt.split('.')[1]!;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { aud?: string; exp?: number };
  } catch {
    return null;
  }
}

const emailSchema = z.object({ email: z.string().email() });

/** Express 4 drops async rejections; route them to the error handler. */
const handle =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export function createSsoGate(opts: SsoGateOptions): SsoGate {
  const clientId = opts.googleClientId;
  const authDisabled = clientId === '';
  const adminEmail = (opts.adminEmail ?? '').trim().toLowerCase();
  const env = {
    emails: new Set([...(opts.allowedEmails ?? [])].map((e) => e.trim().toLowerCase()).filter(Boolean)),
    domain: (opts.allowedDomain ?? '').trim().toLowerCase(),
  };
  const store = opts.store;
  // eslint-disable-next-line no-console
  const log = opts.log ?? ((line: string) => console.warn(line));
  const verify = authDisabled ? null : (opts.verifyIdToken ?? googleVerifier(clientId));
  const devUser: SsoUser = { sub: opts.devUserSub || 'local-dev', email: 'dev@localhost', name: 'Local Dev' };

  const isAdmin = (user: SsoUser): boolean =>
    authDisabled || (!!adminEmail && user.email.toLowerCase() === adminEmail);

  const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!verify) {
      req.user = devUser;
      next();
      return;
    }

    // Every rejection logs a reason + non-PII token facts and returns a
    // reason code — "why am I 401 in prod" must not require guesswork.
    const reject = (status: number, reason: string, detail?: string) => {
      log(`auth reject ${status} ${reason} ${req.method} ${req.path}${detail ? ` ${detail}` : ''}`);
      res.status(status).json({ error: reason });
    };

    const match = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
    if (!match) {
      reject(401, 'missing bearer token');
      return;
    }

    try {
      const payload = await verify(match[1]!, clientId);
      if (!payload?.sub || !payload.email) {
        reject(401, 'invalid token payload');
        return;
      }
      // An unverified address is a claim, not an identity: without this
      // anyone could name an invited (or the Admin's) email on their account.
      if (payload.email_verified !== true) {
        reject(401, 'email not verified', `email=${payload.email}`);
        return;
      }
      if (!(await emailAllowed(payload.email, payload.hd, store, env))) {
        reject(403, 'account not authorized for this app', `email=${payload.email}`);
        return;
      }
      req.user = { sub: payload.sub, email: payload.email, ...(payload.name ? { name: payload.name } : {}) };
      next();
    } catch (e) {
      // Surface WHAT failed (expired vs wrong audience vs bad signature) —
      // the library's message says which without leaking the token.
      const msg = e instanceof Error ? e.message.slice(0, 200) : 'unknown';
      const claims = decodeUnverified(match[1]!);
      reject(
        401,
        'token verification failed',
        `lib="${msg}" aud=${claims?.aud === clientId ? 'ok' : 'MISMATCH'} exp=${claims?.exp ?? '?'} now=${Math.floor(Date.now() / 1000)}`,
      );
    }
  };

  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !isAdmin(req.user)) {
      res.status(403).json({ error: 'admin only' });
      return;
    }
    next();
  };

  const router = Router();

  // Who am I (and may I manage the allow-list)? Every signed-in user.
  router.get('/me', (req, res) => {
    const user = req.user!;
    res.json({ email: user.email, ...(user.name ? { name: user.name } : {}), isAdmin: isAdmin(user) });
  });

  router.use('/allowlist', requireAdmin);

  router.get(
    '/allowlist',
    handle(async (_req, res) => {
      res.json({ emails: await store.listAllowedEmails() });
    }),
  );

  router.post(
    '/allowlist',
    handle(async (req, res) => {
      const parsed = emailSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid email' });
        return;
      }
      await store.addAllowedEmail(parsed.data.email);
      res.json({ emails: await store.listAllowedEmails() });
    }),
  );

  router.delete(
    '/allowlist/:email',
    handle(async (req, res) => {
      if (!(await store.removeAllowedEmail(req.params['email']!))) {
        res.status(404).json({ error: 'not in allow-list' });
        return;
      }
      res.json({ emails: await store.listAllowedEmails() });
    }),
  );

  return {
    authDisabled,
    requireAuth,
    requireAdmin,
    router,
    isAdmin,
    emailAllowed: (email, hostedDomain) => emailAllowed(email, hostedDomain, store, env),
  };
}
