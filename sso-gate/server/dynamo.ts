/**
 * DynamoDB allow-list: one global item (pk CONFIG / sk ALLOWLIST) in a table
 * keyed by string `pk` + `sk` — the shape the SsoGate CDK construct creates,
 * and the item resume.landry.bot has always used. Separate from store.ts so a
 * site without DynamoDB never imports the AWS SDK.
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { AllowListStore } from './store.js';

/** The slice of DynamoDBDocumentClient this store uses. */
export interface DocSender {
  send(command: GetCommand | PutCommand): Promise<{ Item?: Record<string, unknown> | undefined }>;
}

export const ALLOWLIST_KEY = { pk: 'CONFIG', sk: 'ALLOWLIST' } as const;

export class DynamoAllowListStore implements AllowListStore {
  constructor(
    private readonly doc: DocSender,
    private readonly table: string,
  ) {}

  async listAllowedEmails(): Promise<string[]> {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: ALLOWLIST_KEY, ConsistentRead: true }));
    const emails = (out.Item?.['emails'] as string[] | undefined) ?? [];
    return emails.slice().sort();
  }

  async addAllowedEmail(email: string): Promise<void> {
    const emails = new Set(await this.listAllowedEmails());
    emails.add(email.toLowerCase());
    await this.put(emails);
  }

  async removeAllowedEmail(email: string): Promise<boolean> {
    const emails = new Set(await this.listAllowedEmails());
    if (!emails.delete(email.toLowerCase())) return false;
    await this.put(emails);
    return true;
  }

  private async put(emails: Set<string>): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: { ...ALLOWLIST_KEY, emails: [...emails].sort() } }),
    );
  }
}
