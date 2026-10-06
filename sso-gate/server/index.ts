/**
 * sso-gate/server — verifies landry.bot broker (Cognito) access tokens for an
 * Express API. See ../README.md for wiring.
 */

export { createSsoGate, type Role, type SsoGate, type SsoGateOptions, type SsoUser } from './gate.js';

/**
 * The standard env variables, normalised. The site-client construct
 * (../cdk) sets the LANDRY_* ones on the API function. AUTH=off is honoured
 * only outside Lambda, so a deployed API can never run open.
 */
export function ssoConfigFromEnv(env: Record<string, string | undefined> = process.env) {
  return {
    site: env['LANDRY_SITE'] ?? '',
    userPoolId: env['LANDRY_USER_POOL_ID'] ?? '',
    clientId: env['LANDRY_CLIENT_ID'] ?? '',
    devMode: env['AUTH'] === 'off' && !env['AWS_LAMBDA_FUNCTION_NAME'],
  };
}
