/**
 * sso-gate/cdk — a landry.bot site's sign-in, as one construct: the site's
 * app client in the broker's Cognito pool (landry-auth, auth.landry.bot).
 *
 * The client's NAME is the site key. The broker's pre-token check reads it to
 * decide whose tokens this client may issue, so a site cannot skip the
 * allow-list: it never sees a token for someone not on it.
 *
 * Public client (no secret), authorization code + PKCE, Google as the only
 * identity provider. If `api` is given, it gets the LANDRY_* variables that
 * sso-gate/server's ssoConfigFromEnv() reads.
 *
 * Same-account sites only: the client is created in the pool's account. A
 * site in another account gets its client from the landry-auth stack itself.
 */

import * as cdk from 'aws-cdk-lib';
import { aws_cognito as cognito, aws_ssm as ssm, type aws_lambda as lambda } from 'aws-cdk-lib';
import { Construct } from 'constructs';

/** The broker's SSM exports (landry account, us-east-1). Mirrors landry-auth lib/exports.ts. */
export const BROKER_PARAMS = {
  userPoolId: '/landry/auth/user-pool-id',
  hostedDomain: '/landry/auth/hosted-domain',
  apiUrl: '/landry/auth/api-url',
} as const;

export interface LandrySiteClientProps {
  /** Site key: lowercase letters, digits, dashes. The allow-list is per site key. */
  readonly site: string;
  /** Where the broker may send the browser back with a code. https, or http://localhost for dev. */
  readonly callbackUrls: string[];
  /** Where sign-out may land. Default: the callback URLs. */
  readonly logoutUrls?: string[];
  /** The API function running sso-gate/server. */
  readonly api?: lambda.Function;
  /** Default: the broker's SSM export. */
  readonly userPoolId?: string;
  /**
   * Allow ADMIN_USER_PASSWORD_AUTH, so a deploy smoke test holding IAM
   * credentials for the pool can mint real tokens for a test user. Not
   * reachable from a browser. Default false.
   */
  readonly allowAdminTestAuth?: boolean;
}

const SITE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const URL_RE = /^(https:\/\/[^\s]+|http:\/\/localhost(:\d+)?(\/[^\s]*)?)$/;

export class LandrySiteClient extends Construct {
  readonly client: cognito.UserPoolClient;
  readonly clientId: string;
  readonly userPoolId: string;
  /** e.g. https://auth.landry.bot (resolved at deploy time). */
  readonly hostedDomain: string;
  /** e.g. https://api.auth.landry.bot (resolved at deploy time). */
  readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: LandrySiteClientProps) {
    super(scope, id);
    if (!SITE_RE.test(props.site)) throw new Error(`LandrySiteClient: bad site key "${props.site}"`);
    if (!props.callbackUrls.length) throw new Error('LandrySiteClient: no callback URL — nobody could sign in.');
    for (const u of [...props.callbackUrls, ...(props.logoutUrls ?? [])]) {
      if (!URL_RE.test(u)) throw new Error(`LandrySiteClient: "${u}" must be https (or http://localhost)`);
    }

    this.userPoolId = props.userPoolId ?? ssm.StringParameter.valueForStringParameter(this, BROKER_PARAMS.userPoolId);
    this.hostedDomain = ssm.StringParameter.valueForStringParameter(this, BROKER_PARAMS.hostedDomain);
    this.apiUrl = ssm.StringParameter.valueForStringParameter(this, BROKER_PARAMS.apiUrl);
    const pool = cognito.UserPool.fromUserPoolId(this, 'Pool', this.userPoolId);

    this.client = new cognito.UserPoolClient(this, 'Client', {
      userPool: pool,
      userPoolClientName: props.site,
      generateSecret: false,
      authFlows: props.allowAdminTestAuth ? { adminUserPassword: true } : {},
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: props.callbackUrls,
        logoutUrls: props.logoutUrls ?? props.callbackUrls,
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.GOOGLE],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      // A removed member keeps a token at most this long; refresh re-checks the allow-list.
      accessTokenValidity: cdk.Duration.minutes(60),
      idTokenValidity: cdk.Duration.minutes(60),
      refreshTokenValidity: cdk.Duration.days(30),
    });
    this.clientId = this.client.userPoolClientId;

    if (props.api) {
      props.api.addEnvironment('LANDRY_SITE', props.site);
      props.api.addEnvironment('LANDRY_USER_POOL_ID', this.userPoolId);
      props.api.addEnvironment('LANDRY_CLIENT_ID', this.clientId);
    }
  }
}
