/**
 * sso-gate/cdk: what a site's stack gets from `new LandrySiteClient(...)`,
 * read off the synthesized CloudFormation — the only thing that reaches AWS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { aws_lambda as lambda } from 'aws-cdk-lib';
import { LandrySiteClient, BROKER_PARAMS, type LandrySiteClientProps } from '../cdk/index.js';

function stack(props: Partial<LandrySiteClientProps> = {}, withApi = true) {
  const s = new cdk.Stack(new cdk.App(), 'Site', { env: { account: '111111111111', region: 'us-east-1' } });
  const api = withApi
    ? new lambda.Function(s, 'Api', {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline('exports.handler = async () => ({})'),
        environment: { OTHER: 'kept' },
      })
    : undefined;
  const client = new LandrySiteClient(s, 'Auth', {
    site: 'graph',
    callbackUrls: ['https://graph.landry.bot/'],
    ...(api ? { api } : {}),
    ...props,
  });
  return { s, client, t: Template.fromStack(s) };
}

test('one public app client named for the site: code grant + PKCE, Google only', () => {
  const { t } = stack();
  t.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    ClientName: 'graph',
    GenerateSecret: false,
    AllowedOAuthFlowsUserPoolClient: true,
    AllowedOAuthFlows: ['code'],
    AllowedOAuthScopes: Match.arrayWith(['openid', 'email', 'profile']),
    SupportedIdentityProviders: ['Google'],
    CallbackURLs: ['https://graph.landry.bot/'],
    LogoutURLs: ['https://graph.landry.bot/'],
    EnableTokenRevocation: true,
    PreventUserExistenceErrors: 'ENABLED',
  });
});

test('the pool comes from the broker SSM export unless given', () => {
  const { t } = stack();
  const params = JSON.stringify(t.toJSON().Parameters ?? {});
  assert.match(params, new RegExp(BROKER_PARAMS.userPoolId));
  const explicit = stack({ userPoolId: 'us-east-1_Given' }).t;
  explicit.hasResourceProperties('AWS::Cognito::UserPoolClient', { UserPoolId: 'us-east-1_Given' });
});

test('the API function gets the LANDRY_* variables ssoConfigFromEnv reads, and keeps its own', () => {
  const { t } = stack();
  const env = Object.values(t.findResources('AWS::Lambda::Function'))[0]!['Properties']['Environment']['Variables'];
  assert.equal(env.LANDRY_SITE, 'graph');
  assert.ok(env.LANDRY_USER_POOL_ID);
  assert.deepEqual(Object.keys(env.LANDRY_CLIENT_ID), ['Ref']);
  assert.equal(env.OTHER, 'kept');
});

test('admin password auth (for smoke tests with IAM credentials) only when asked', () => {
  const off = stack().t;
  const flows = Object.values(off.findResources('AWS::Cognito::UserPoolClient'))[0]!['Properties']['ExplicitAuthFlows'];
  assert.ok(!JSON.stringify(flows ?? []).includes('ADMIN_USER_PASSWORD'));
  stack({ allowAdminTestAuth: true }).t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    ExplicitAuthFlows: Match.arrayWith(['ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']),
  });
});

test('a bad site key or no callback URL fails at synth', () => {
  assert.throws(() => stack({ site: 'Graph Site' }), /site/);
  assert.throws(() => stack({ callbackUrls: [] }), /callback/);
  assert.throws(() => stack({ callbackUrls: ['http://graph.landry.bot/'] }), /https/);
});

test('localhost callbacks are allowed for local dev', () => {
  stack({ callbackUrls: ['https://graph.landry.bot/', 'http://localhost:8080/'] }).t.hasResourceProperties(
    'AWS::Cognito::UserPoolClient',
    { CallbackURLs: ['https://graph.landry.bot/', 'http://localhost:8080/'] },
  );
});

test('given a pool id and never asked for the broker URLs, it reads no SSM (works inside the broker stack itself)', () => {
  const { t } = stack({ userPoolId: 'us-east-1_Given' }, false);
  assert.equal(Object.keys(t.toJSON().Parameters ?? {}).filter((k) => !k.startsWith('BootstrapVersion')).length, 0);
});
