/**
 * Where the Admin-managed allow-list lives. One global list per site (not per
 * user). A site's own store can satisfy this interface directly, or delegate
 * to one of the implementations here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AllowListStore {
  /** Sorted, lowercased. */
  listAllowedEmails(): Promise<string[]>;
  /** Lowercases; adding an existing email is a no-op. */
  addAllowedEmail(email: string): Promise<void>;
  /** Returns false when the email wasn't present. */
  removeAllowedEmail(email: string): Promise<boolean>;
}

/** Local dev: the list is `<dataDir>/allowlist.json`. */
export class FileAllowListStore implements AllowListStore {
  constructor(private readonly dataDir: string) {}

  private file(): string {
    return path.join(this.dataDir, 'allowlist.json');
  }

  async listAllowedEmails(): Promise<string[]> {
    if (!fs.existsSync(this.file())) return [];
    const data = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as { emails?: string[] };
    return (data.emails ?? []).slice().sort();
  }

  async addAllowedEmail(email: string): Promise<void> {
    const emails = new Set(await this.listAllowedEmails());
    emails.add(email.toLowerCase());
    this.write([...emails]);
  }

  async removeAllowedEmail(email: string): Promise<boolean> {
    const emails = new Set(await this.listAllowedEmails());
    if (!emails.delete(email.toLowerCase())) return false;
    this.write([...emails]);
    return true;
  }

  private write(emails: string[]): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ emails: emails.sort() }, null, 2));
    fs.renameSync(tmp, this.file()); // atomic
  }
}
