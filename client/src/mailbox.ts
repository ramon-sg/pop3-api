import {
  type PollRecord,
  type WaitDiagnostics,
  formatDiagnostics,
  summarize,
  verdictOf,
} from "./diagnostics.js";
import { describeFilter, matches, recipientsOf, toRegExp } from "./match.js";
import type {
  ApiResponse,
  Mail,
  MailboxMeta,
  MailFilter,
  MailboxOptions,
  WaitOptions,
} from "./types.js";

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_INTERVAL = 5_000;
const DEFAULT_REQUEST_TIMEOUT = 120_000;
const DEFAULT_CODE = /\b\d{6}\b/;
/** Mails listed in a diagnostic when the filter has no address. */
const NEARBY_LIMIT = 10;
/** `waitFor` calls kept for `history()`. */
const HISTORY_LIMIT = 50;

export type Mailbox = ReturnType<typeof createMailbox>;

/**
 * @description Error that retrying cannot fix (bad credentials, bad request,
 * wrong URL). `waitFor` fails right away instead of waiting for the timeout.
 */
export class MailboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxError";
  }
}

/**
 * @description Creates a mailbox that polls pop3-api and waits for mails.
 *
 * pop3-api >= 0.0.3 keeps the mails it consumes and, with `?to=`, returns only
 * the mails of that address. When the filter has a string `to`, every poll asks
 * only for that address; otherwise it gets every retained mail of the account.
 * The mailbox remembers what it received (deduplicated by `uidl`) and which
 * mails `waitFor` already returned.
 *
 * @example
 * ```ts
 * const mailbox = createMailbox({ url, username, password });
 * const to = mailbox.alias();
 * await register(to);
 * const mail = await mailbox.waitFor({ to, subject: /bienvenid/i });
 * ```
 */
export function createMailbox(options: MailboxOptions) {
  const { url, username, password } = options;

  for (const key of ["url", "username", "password"] as const) {
    if (!options[key]) {
      throw new MailboxError(`createMailbox: \`${key}\` is required`);
    }
  }

  try {
    new URL(url);
  } catch {
    throw new MailboxError(`createMailbox: \`url\` is not a valid URL: ${url}`);
  }

  const request = options.fetch ?? fetch;
  const requestTimeout = positive(
    "requestTimeout",
    options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT
  );
  const mails = new Map<string, Mail>();
  const taken = new Set<string>();
  /** In-flight polls, per requested address ("" = every mail). */
  const inflight = new Map<string, Promise<Mail[]>>();
  let lastMeta: MailboxMeta | undefined;
  const waits: Omit<WaitDiagnostics, "nearby" | "meta" | "verdict">[] = [];
  let waitSeq = 0;

  /**
   * @description Unique address for one test, built with the `+` alias that
   * Gmail delivers to the same inbox: `user+k3j9x0a1b2-1727712000000@gmail.com`,
   * or `user+signup-k3j9x0a1b2-1727712000000@gmail.com` with a `tag`.
   */
  function alias(tag?: string): string {
    const [user, domain] = username.split("@");
    const random = Math.random().toString(36).slice(2, 12);
    const parts = [tag, random, Date.now()].filter(Boolean).join("-");

    return `${user}+${parts}@${domain}`;
  }

  /**
   * @description Polls pop3-api once, for `to` only when given, and stores the
   * mails it returns. Concurrent calls for the same address share the request.
   * Returns only the mails that were not received before.
   */
  function poll(to?: string): Promise<Mail[]> {
    const address = to?.trim().toLowerCase() ?? "";
    let current = inflight.get(address);

    if (!current) {
      current = fetchMails(address).finally(() => inflight.delete(address));
      inflight.set(address, current);
    }

    return current;
  }

  async function fetchMails(address: string): Promise<Mail[]> {
    const target = new URL(url);
    if (address) target.searchParams.set("to", address);

    const res = await request(target.toString(), {
      headers: {
        "X-POP3-USERNAME": username,
        "X-POP3-PASSWORD": password,
      },
      // pop3-api >= 0.0.3 closes the POP3 session without QUIT when the
      // request is aborted, so the mails of an abandoned poll are not lost.
      signal: AbortSignal.timeout(requestTimeout),
    });

    const body = (await res.json().catch(() => null)) as ApiResponse | null;

    if (!body) {
      const message = `pop3-api answered ${res.status} without JSON`;
      throw isFatal(res.status) ? new MailboxError(message) : new Error(message);
    }

    if (!body.success) {
      const message = `pop3-api answered ${res.status}: ${body.error}`;
      throw isFatal(res.status, body.error)
        ? new MailboxError(message)
        : new Error(message);
    }

    lastMeta = body.meta;
    const fresh: Mail[] = [];

    for (const mail of body.data) {
      const key = keyOf(mail);
      if (mails.has(key)) continue;
      mails.set(key, mail);
      fresh.push(mail);
    }

    return fresh;
  }

  /**
   * @description Searches every stored mail without polling, including the
   * ones already returned by `waitFor`.
   */
  function find(filter: MailFilter = {}): Mail | undefined {
    return search(filter, false);
  }

  function search(filter: MailFilter, onlyUntaken: boolean): Mail | undefined {
    for (const [key, mail] of mails) {
      if (onlyUntaken && taken.has(key)) continue;
      if (matches(mail, filter)) return mail;
    }
    return undefined;
  }

  /**
   * @description Waits for a mail that matches `filter`: looks in memory first
   * and polls until one arrives or `timeout` passes.
   *
   * Each mail is returned by `waitFor` at most once, so waiting again with the
   * same filter (e.g. after "resend code") gets the next mail, not the old one.
   *
   * Transient errors (network, 502, 504) are retried; bad credentials and
   * other 4xx fail right away with `MailboxError`.
   */
  async function waitFor(
    filter: MailFilter = {},
    waitOptions: WaitOptions = {}
  ): Promise<Mail> {
    const timeout = positive(
      "timeout",
      waitOptions.timeout ?? options.wait?.timeout ?? DEFAULT_TIMEOUT
    );
    const interval = positive(
      "interval",
      waitOptions.interval ?? options.wait?.interval ?? DEFAULT_INTERVAL
    );
    const start = Date.now();
    const to = typeof filter.to === "string" ? filter.to : undefined;
    const record = {
      id: ++waitSeq,
      filter: describeFilter(filter),
      address: to?.trim().toLowerCase(),
      startedAt: new Date(start).toISOString(),
      endedAt: undefined as string | undefined,
      found: false,
      polls: [] as PollRecord[],
    };
    waits.push(record);
    if (waits.length > HISTORY_LIMIT) waits.shift();

    while (true) {
      const found = search(filter, true);
      if (found) {
        taken.add(keyOf(found));
        record.found = true;
        record.endedAt = new Date().toISOString();
        return found;
      }

      const elapsed = Date.now() - start;
      if (elapsed >= timeout && record.polls.length > 0) {
        record.endedAt = new Date().toISOString();
        throw new Error(
          `Mail not found after ${Math.round(elapsed / 1000)}s.\n` +
            formatDiagnostics(diagnose(record))
        );
      }

      if (record.polls.length > 0) {
        await sleep(Math.min(interval, timeout - elapsed));
      }

      const pollStart = Date.now();
      const entry: PollRecord = { at: new Date(pollStart).toISOString(), durationMs: 0 };
      record.polls.push(entry);
      try {
        // Stop waiting at the deadline, but let the poll finish: whatever it
        // brings is still stored for the next `waitFor`.
        const fresh = await within(poll(to), timeout - (pollStart - start));
        if (fresh === undefined) entry.pending = true;
        else entry.newMails = fresh.length;
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
        if (err instanceof MailboxError) {
          entry.durationMs = Date.now() - pollStart;
          throw err;
        }
      }
      entry.durationMs = Date.now() - pollStart;
    }
  }

  /** @description Diagnostics of a `waitFor` record, computed now. */
  function diagnose(
    record: Omit<WaitDiagnostics, "nearby" | "meta" | "verdict">
  ): WaitDiagnostics {
    const received = [...mails.entries()].map(([key, mail]) => ({
      mail,
      taken: taken.has(key),
      to: recipientsOf(mail),
    }));

    const nearby = (
      record.address
        ? received.filter((r) => r.to.includes(record.address!))
        : received.slice(-NEARBY_LIMIT)
    ).map((r) => summarize(r.mail, r.taken, r.to));

    return {
      ...record,
      polls: [...record.polls],
      nearby,
      meta: lastMeta,
      verdict: verdictOf(record.found, nearby, record.address, lastMeta),
    };
  }

  /**
   * @description Diagnostics for `filter`: the mails received for its address
   * (or the last ones received), the polls of the latest `waitFor` with the
   * same filter and the last `meta` of pop3-api. Only summaries: never the
   * body nor the attachments.
   */
  function diagnostics(filter: MailFilter = {}): WaitDiagnostics {
    const described = describeFilter(filter);
    const latest = [...waits].reverse().find((w) => w.filter === described);
    const to = typeof filter.to === "string" ? filter.to : undefined;

    return diagnose(
      latest ?? {
        id: 0,
        filter: described,
        address: to?.trim().toLowerCase(),
        startedAt: new Date().toISOString(),
        found: false,
        polls: [],
      }
    );
  }

  /**
   * @description Diagnostics of the last `waitFor` calls (at most 50), oldest
   * first; only those after `sinceId` when given.
   */
  function history(sinceId = 0): WaitDiagnostics[] {
    return waits.filter((w) => w.id > sinceId).map(diagnose);
  }

  /**
   * @description `href`s of the mail's HTML (or URLs of its text when the HTML
   * has none), optionally filtered.
   */
  function links(mail: Mail, filter?: RegExp | string): string[] {
    const hrefs = [
      ...(mail.html ?? "").matchAll(/\shref\s*=\s*(["'])([\s\S]*?)\1/gi),
    ].map((m) => decodeEntities(m[2]!.trim()));

    const found = hrefs.length
      ? hrefs
      : [...(mail.text ?? "").matchAll(/https?:\/\/[^\s<>"'\]]+/g)].map(
          // A URL at the end of a sentence carries its punctuation.
          (m) => m[0].replace(/[.,;:!?)]+$/, "")
        );

    if (filter === undefined) return found;

    const regExp = typeof filter === "string" ? null : toRegExp(filter);

    return found.filter((href) =>
      regExp ? regExp.test(href) : href.includes(filter as string)
    );
  }

  /**
   * @description First match of `pattern` in the text (or HTML) of the mail. By
   * default a 6 digit code. Returns the first capture group if there is one.
   */
  function code(mail: Mail, pattern: RegExp = DEFAULT_CODE): string | undefined {
    const source = mail.text || htmlToText(mail.html ?? "");
    const match = source.match(toRegExp(pattern));

    return match ? match[1] ?? match[0] : undefined;
  }

  return {
    alias,
    poll,
    find,
    waitFor,
    links,
    code,
    /** @description Copy of every mail received so far. */
    all: (): Mail[] => [...mails.values()],
    /** @description `meta` of the last successful poll (pop3-api >= 0.0.3). */
    meta: (): MailboxMeta | undefined => lastMeta,
    diagnostics,
    history,
    /** @description Id of the latest `waitFor`, to read `history()` after it. */
    lastWaitId: (): number => waitSeq,
    /** @description Forgets the stored mails. */
    clear: (): void => {
      mails.clear();
      taken.clear();
    },
  };
}

function keyOf(mail: Mail): string {
  return (
    mail.uidl ??
    mail.messageId ??
    JSON.stringify([
      mail.date,
      mail.subject,
      mail.to,
      mail.error,
      mail.headers,
      mail.text,
      mail.html,
    ])
  );
}

/**
 * Waiting will not fix it: bad credentials or any 4xx (bad request, wrong URL,
 * proxy auth) except 408 and 429, which are transient.
 */
function isFatal(status: number, error = ""): boolean {
  if (status === 408 || status === 429) return false;

  return (
    (status >= 400 && status < 500) ||
    /\[AUTH\]|authentication failed/i.test(error)
  );
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a number >= 0, got ${value}`);
  }
  return value;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms));
  });

  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
