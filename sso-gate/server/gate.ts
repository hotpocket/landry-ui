/**
 * THE GATE. The browser signs in through the landry.bot broker
 * (auth.landry.bot, Cognito with Google) and sends the Cognito ACCESS token as
 * `Authorization: Bearer <token>`. We verify signature, issuer, expiry,
 * token_use and this site's client id, then read the broker's stamp:
 * landry_site must be this site and landry_role is admin|user.
 *
 * Who may sign in at all is decided centrally, before a token exists: the
 * broker's pre-token check refuses anyone not on this site's allow-list
 * (managed through the broker API, not here). A token without the stamp is
 * refused, so a misconfigured pool fails closed.
 *
 * Fail closed: no pool id or client id => every request is 401, unless dev
 * mode is explicit (AUTH=off outside Lambda), where every request is a fixed
 * dev admin.
 */

import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';

export type Role = 'admin' | 'user';

export interface SsoUser {
  /** Cognito's subject id for this person (stable within the pool). */
  sub: string;
  email: string;
  role: Role;
  site: string;
  /**
   * The Google account id behind this sign-in. Sites that keyed data on the
   * Google ID token's `sub` before the broker use this to find it.
   */
  googleSub?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SsoUser;
    }
  }
}

export interface SsoGateOptions {
  /** The site key: the app client's name in the pool. */
  site: string;
  userPoolId: string;
  /** This site's app client id; tokens for other sites' clients are refused. */
  clientId: string;
  /** Local dev only: no verification, every request the dev admin. */
  devMode?: boolean;
  /** Test seam: a JWKS to trust instead of fetching the pool's. */
  jwks?: { keys: object[] };
  /** Where rejection reasons go; defaults to console.warn (CloudWatch). */
  log?: (line: string) => void;
}

export interface SsoGate {
  readonly authDisabled: boolean;
  /** 401 without a valid token for this site's client; 403 if the broker did not let them into this site. */
  readonly requireAuth: RequestHandler;
  /** 403 unless req.user is a site admin; mount after requireAuth. */
  readonly requireAdmin: RequestHandler;
  /** GET /me. Mount after requireAuth. */
  readonly router: Router;
}

const GOOGLE_USERNAME = /^google_(.+)$/i;

export function createSsoGate(opts: SsoGateOptions): SsoGate {
  // eslint-disable-next-line no-console
  const log = opts.log ?? ((line: string) => console.warn(line));
  const configured = !!opts.userPoolId && !!opts.clientId && !!opts.site;
  const devMode = !!opts.devMode && !configured;
  const devUser: SsoUser = { sub: 'local-dev', email: 'dev@localhost', role: 'admin', site: opts.site || 'dev' };

  let verifier: { verify(token: string): Promise<Record<string, unknown>> } | null = null;
  if (configured) {
    const v = CognitoJwtVerifier.create({ userPoolId: opts.userPoolId, tokenUse: 'access', clientId: opts.clientId });
    if (opts.jwks) v.cacheJwks(opts.jwks as never);
    verifier = { verify: (t) => v.verify(t) as Promise<Record<string, unknown>> };
  }

  const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (devMode) {
      req.user = devUser;
      next();
      return;
    }
    const reject = (status: number, reason: string, detail?: string) => {
      log(`auth reject ${status} ${reason} ${req.method} ${req.path}${detail ? ` ${detail}` : ''}`);
      res.status(status).json({ error: reason });
    };
    if (!verifier) {
      reject(401, 'sign-in is not configured');
      return;
    }
    const match = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
    if (!match) {
      reject(401, 'missing bearer token');
      return;
    }
    let claims: Record<string, unknown>;
    try {
      claims = await verifier.verify(match[1]!);
    } catch (e) {
      // Say WHAT failed (expired, wrong client, bad signature) without the token.
      reject(401, 'token verification failed', `lib="${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}"`);
      return;
    }
    const email = typeof claims['email'] === 'string' ? claims['email'] : '';
    const role = claims['landry_role'];
    if (claims['landry_site'] !== opts.site || (role !== 'admin' && role !== 'user') || !email) {
      reject(403, 'account not authorized for this app', `site=${String(claims['landry_site'])} role=${String(role)}`);
      return;
    }
    const googleSub = GOOGLE_USERNAME.exec(String(claims['username'] ?? ''))?.[1];
    req.user = {
      sub: String(claims['sub']),
      email,
      role,
      site: opts.site,
      ...(googleSub ? { googleSub } : {}),
    };
    next();
  };

  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'admin only' });
      return;
    }
    next();
  };

  const router = Router();
  router.get('/me', (req, res) => {
    const u = req.user!;
    res.json({ email: u.email, role: u.role, isAdmin: u.role === 'admin', site: u.site });
  });

  return {
    authDisabled: devMode,
    // Express 4 drops async rejections; route them to the error handler.
    requireAuth: (req, res, next) => {
      requireAuth(req, res, next).catch(next);
    },
    requireAdmin,
    router,
  };
}
