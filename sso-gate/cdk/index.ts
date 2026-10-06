/**
 * sso-gate/cdk — the infrastructure half of the gate: configures the API
 * function that runs sso-gate/server (createSsoGate + ssoConfigFromEnv) and
 * gives it the DynamoDB table its allow-list item lives in.
 *
 * A site with its own single table (pk/sk strings) passes it in; otherwise a
 * table of that shape is created. Either way the function gets read/write on
 * it and its name under DDB_TABLE (or tableEnvVar).
 */

import * as cdk from 'aws-cdk-lib';
import { aws_dynamodb as dynamodb, type aws_lambda as lambda } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface SsoGateProps {
  /** The API function running sso-gate/server. */
  readonly api: lambda.Function;
  /** Google OAuth Web client id the API verifies ID tokens against. */
  readonly googleClientId: string;
  /** The one account that manages the allow-list from the UI. */
  readonly adminEmail: string;
  /** Comma-separated bootstrap emails, always allowed. Default none. */
  readonly allowedEmails?: string;
  /** Bootstrap Google Workspace / email domain. Default none. */
  readonly allowedDomain?: string;
  /** The site's table (string pk + sk). Omit to create one. */
  readonly table?: dynamodb.ITable;
  /** Physical name for a created table. Default: CloudFormation-generated. */
  readonly tableName?: string;
  /** Env var the table name is passed in. Default DDB_TABLE. */
  readonly tableEnvVar?: string;
}

export class SsoGate extends Construct {
  /** Where the allow-list item (pk CONFIG / sk ALLOWLIST) lives. */
  readonly table: dynamodb.ITable;

  constructor(scope: Construct, id: string, props: SsoGateProps) {
    super(scope, id);
    // The server half reads an empty client id as local dev: auth off, every
    // request the Admin. Never let that synthesize for AWS.
    if (!cdk.Token.isUnresolved(props.googleClientId) && props.googleClientId.trim() === '') {
      throw new Error('SsoGate: googleClientId is empty — the API would run with auth disabled.');
    }
    if (props.table && props.tableName) {
      throw new Error('SsoGate: tableName names a table it creates; omit it when passing table.');
    }

    this.table =
      props.table ??
      new dynamodb.Table(this, 'Table', {
        ...(props.tableName ? { tableName: props.tableName } : {}),
        partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        pointInTimeRecovery: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN, // the allow-list is user data
      });

    const { api } = props;
    api.addEnvironment('GOOGLE_CLIENT_ID', props.googleClientId);
    api.addEnvironment('ADMIN_EMAIL', props.adminEmail);
    api.addEnvironment('ALLOWED_EMAILS', props.allowedEmails ?? '');
    api.addEnvironment('ALLOWED_DOMAIN', props.allowedDomain ?? '');
    api.addEnvironment(props.tableEnvVar ?? 'DDB_TABLE', this.table.tableName);
    this.table.grantReadWriteData(api);
  }
}
