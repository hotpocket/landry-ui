/**
 * sso-gate/cdk: what a stack gets from `new SsoGate(...)`, read off the
 * synthesized CloudFormation — the only thing that reaches AWS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { aws_dynamodb as dynamodb, aws_lambda as lambda } from 'aws-cdk-lib';
import { SsoGate, type SsoGateProps } from '../cdk/index.js';

function stack(props: Partial<SsoGateProps> & { ownTable?: boolean } = {}) {
  const s = new cdk.Stack(new cdk.App(), 'Site');
  const api = new lambda.Function(s, 'Api', {
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({})'),
    environment: { OTHER: 'kept' },
  });
  const table = props.ownTable
    ? new dynamodb.Table(s, 'SiteTable', {
        partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      })
    : undefined;
  const { ownTable: _o, ...rest } = props;
  const gate = new SsoGate(s, 'Sso', {
    api,
    googleClientId: 'cid.apps.googleusercontent.com',
    adminEmail: 'sirjava@gmail.com',
    ...(table ? { table } : {}),
    ...rest,
  });
  return { s, gate, t: Template.fromStack(s) };
}

const fnEnv = (t: Template) =>
  Object.values(t.findResources('AWS::Lambda::Function'))[0]!['Properties']['Environment']['Variables'];

test('the API function is configured for the gate and keeps its own env', () => {
  const env = fnEnv(stack({ allowedEmails: 'a@x.com,b@x.com', allowedDomain: 'corp.com' }).t);
  assert.equal(env.GOOGLE_CLIENT_ID, 'cid.apps.googleusercontent.com');
  assert.equal(env.ADMIN_EMAIL, 'sirjava@gmail.com');
  assert.equal(env.ALLOWED_EMAILS, 'a@x.com,b@x.com');
  assert.equal(env.ALLOWED_DOMAIN, 'corp.com');
  assert.equal(env.OTHER, 'kept');
});

test('bootstrap lists default to empty (the Admin-managed store is the list)', () => {
  const env = fnEnv(stack().t);
  assert.equal(env.ALLOWED_EMAILS, '');
  assert.equal(env.ALLOWED_DOMAIN, '');
});

test('no table given: one is created with the allow-list key shape, and kept on delete', () => {
  const { t } = stack({ tableName: 'GraphSite' });
  t.resourceCountIs('AWS::DynamoDB::Table', 1);
  t.hasResource('AWS::DynamoDB::Table', {
    DeletionPolicy: 'Retain',
    Properties: {
      TableName: 'GraphSite',
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    },
  });
});

test('the table name reaches the function under DDB_TABLE, or the name the site picks', () => {
  const { t } = stack();
  const ref = fnEnv(t).DDB_TABLE;
  assert.deepEqual(Object.keys(ref), ['Ref']);
  assert.ok(t.findResources('AWS::DynamoDB::Table')[ref.Ref]);
  assert.ok(fnEnv(stack({ tableEnvVar: 'SSO_TABLE' }).t).SSO_TABLE);
});

test('the function may read and write the table', () => {
  const { t } = stack();
  t.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(['dynamodb:GetItem', 'dynamodb:PutItem']),
          Effect: 'Allow',
        }),
      ]),
    },
  });
});

test("a site's existing table is used, not a new one", () => {
  const { t, gate } = stack({ ownTable: true });
  t.resourceCountIs('AWS::DynamoDB::Table', 1);
  const ref = fnEnv(t).DDB_TABLE.Ref as string;
  assert.match(ref, /^SiteTable/);
  assert.equal(gate.table.node.id, 'SiteTable');
});

test('a table name for a table the site passed in is a mistake, not silently ignored', () => {
  assert.throws(() => stack({ ownTable: true, tableName: 'X' }), /tableName/);
});

test('an empty Google client id is refused at synth: it would deploy auth switched off', () => {
  // The server half treats no client id as local dev — every request the
  // dev user, who is the Admin. That must never reach AWS.
  assert.throws(() => stack({ googleClientId: '' }), /googleClientId/);
  assert.throws(() => stack({ googleClientId: '  ' }), /googleClientId/);
});
