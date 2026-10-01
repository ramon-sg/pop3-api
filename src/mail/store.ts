import { createHash } from "node:crypto";

import type { Address, Mail } from "./types";

export type LastPoll = {
  at: string;
  durationMs: number;
  /** Mails this poll added to the store (of any alias of the account). */
  newMails: number;
  error?: string;
};

export type StoreMeta = {
  /** Mails retained for the alias (or the whole account without `to`). */
  retained: number;
  /** Mails of the alias (or the account) dropped by retention or by the cap. */
  expired: number;
  lastPoll: LastPoll | null;
  retentionMs: number;
};

type Entry = { mail: Mail; storedAt: number; recipients: Set<string> };

type Account = {
  /** Keyed by `uidl`, in arrival order (Map keeps insertion order). */
  entries: Map<string, Entry>;
  /** Expired mails per recipient address, plus `*` for the whole account. */
  expired: Map<string, number>;
  lastPoll: LastPoll | null;
};

const ALL = "*";

/**
 * @description Key of an account: the credentials, hashed. Mails are only
 * handed to whoever presents the same username and password.
 */
export function accountKey(username: string, password: string): string {
  return createHash("sha256").update(`${username}\0${password}`).digest("hex");
}

/**
 * @description Mails consumed from the POP3 server, kept in memory for
 * `retentionMs` (and at most `max` per account). The server consumes the whole
 * inbox on every poll, while each caller only wants the mails of its own `+`
 * alias: keeping them here lets every alias get its mails, whoever polled.
 */
export class MailStore {
  private accounts = new Map<string, Account>();

  constructor(
    private readonly retentionMs: number,
    private readonly max: number,
    private readonly now: () => number = Date.now
  ) {}

  /** @returns how many of `mails` were not stored yet. */
  add(key: string, mails: Mail[]): number {
    const account = this.account(key);
    this.prune(account);
    let added = 0;

    for (const mail of mails) {
      const id = mail.uidl ?? mail.messageId;
      if (!id || account.entries.has(id)) continue;

      account.entries.set(id, {
        mail,
        storedAt: this.now(),
        recipients: recipients(mail),
      });
      added++;
    }

    this.prune(account);
    return added;
  }

  recordPoll(key: string, lastPoll: LastPoll) {
    this.account(key).lastPoll = lastPoll;
  }

  /**
   * @description Retained mails of the account, only those delivered to `to`
   * when given (case-insensitive, in to/cc/bcc/Delivered-To, or in the raw
   * headers of an unreadable mail).
   */
  list(key: string, to?: string): { mails: Mail[]; meta: StoreMeta } {
    const account = this.account(key);
    this.prune(account);

    const address = to?.trim().toLowerCase();
    const mails = [...account.entries.values()]
      .filter((entry) => !address || entry.recipients.has(address))
      .map((entry) => entry.mail);

    return {
      mails,
      meta: {
        retained: mails.length,
        expired: account.expired.get(address || ALL) ?? 0,
        lastPoll: account.lastPoll,
        retentionMs: this.retentionMs,
      },
    };
  }

  private account(key: string): Account {
    let account = this.accounts.get(key);
    if (!account) {
      account = { entries: new Map(), expired: new Map(), lastPoll: null };
      this.accounts.set(key, account);
    }
    return account;
  }

  private prune(account: Account) {
    const limit = this.now() - this.retentionMs;

    for (const [id, entry] of account.entries) {
      // Oldest first: stop at the first one still within retention and cap.
      if (entry.storedAt > limit && account.entries.size <= this.max) break;
      account.entries.delete(id);
      for (const address of [ALL, ...entry.recipients]) {
        account.expired.set(address, (account.expired.get(address) ?? 0) + 1);
      }
    }
  }
}

/**
 * @description Every address the mail was delivered to. An unreadable mail has
 * no parsed recipients, so they are read from its raw headers: otherwise the
 * `to` filter would never hand it to its owner.
 */
export function recipients(mail: Mail): Set<string> {
  const found = new Set<string>();
  const add = (address?: string) => {
    if (address) found.add(address.trim().toLowerCase());
  };
  const addAll = (list: Address[] = []) => {
    for (const item of list) {
      if (item.group) addAll(item.group);
      else add(item.address);
    }
  };

  addAll(mail.to);
  addAll(mail.cc);
  addAll(mail.bcc);
  add(mail.deliveredTo);

  if (mail.headers) {
    // Unfold continuation lines before reading each header.
    const unfolded = mail.headers.replace(/\r?\n[ \t]+/g, " ");
    for (const line of unfolded.split(/\r?\n/)) {
      if (!/^(to|cc|bcc|delivered-to):/i.test(line)) continue;
      for (const address of line.matchAll(/[^\s<>,;:"']+@[^\s<>,;"']+/g)) {
        add(address[0]);
      }
    }
  }

  return found;
}
