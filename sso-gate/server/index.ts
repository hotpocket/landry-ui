/**
 * sso-gate/server — Google sign-in + Admin-managed allow-list for an Express
 * API. See ../README.md for wiring. DynamoAllowListStore is in ./dynamo.js so
 * sites without DynamoDB never import the AWS SDK.
 */

export {
  createSsoGate,
  emailAllowed,
  type IdTokenClaims,
  type IdTokenVerifier,
  type SsoGate,
  type SsoGateOptions,
  type SsoUser,
} from './gate.js';
export { FileAllowListStore, type AllowListStore } from './store.js';

/** The standard env variables, normalised. One reader for every site. */
export function ssoConfigFromEnv(env: Record<string, string | undefined> = process.env) {
  return {
    googleClientId: env['GOOGLE_CLIENT_ID'] ?? '',
    adminEmail: (env['ADMIN_EMAIL'] ?? '').trim().toLowerCase(),
    allowedEmails: new Set(
      (env['ALLOWED_EMAILS'] ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
    allowedDomain: (env['ALLOWED_DOMAIN'] ?? '').trim().toLowerCase(),
    devUserSub: env['DEV_USER_SUB'] ?? '',
  };
}
