import { describeFilter, matches, toRegExp } from "./match.js";
import type {
  ApiResponse,
  Mail,
  MailFilter,
  MailboxOptions,
  WaitOptions,
} from "./types.js";

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_INTERVAL = 5_000;
const DEFAULT_REQUEST_TIMEOUT = 120_000;
const DEFAULT_CODE = /\b\d{6}\b/;

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
 * @description Creates a mailbox that polls pop3-api and keeps in memory every
 * mail it receives, not only the one being waited for: pop3-api hands each mail
 * over only once, so a mail dropped here would be lost.
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

  const request = options.fetch ?? fetch;
  const requestTimeout = positive(
    "requestTimeout",
    options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT
  );
  const mails = new Map<string, Mail>();
  const taken = new Set<string>();
  let inflight: Promise<Mail[]> | null = null;

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
   * @description Polls pop3-api once and stores the new mails. Concurrent calls
   * share the same request. Returns only the mails that were not stored yet.
   */
  function poll(): Promise<Mail[]> {
    inflight ??= fetchMails().finally(() => {
      inflight = null;
    });

    return inflight;
  }

  async function fetchMails(): Promise<Mail[]> {
    const res = await request(url, {
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
    let polls = 0;
    let lastError: Error | null = null;

    while (true) {
      const found = search(filter, true);
      if (found) {
        taken.add(keyOf(found));
        return found;
      }

      const elapsed = Date.now() - start;
      if (elapsed >= timeout && polls > 0) {
        throw new Error(notFoundMessage(filter, elapsed, polls, lastError));
      }

      if (polls > 0) {
        await sleep(Math.min(interval, timeout - elapsed));
      }

      polls++;
      try {
        // Stop waiting at the deadline, but let the poll finish: whatever it
        // brings is still stored for the next `waitFor`.
        await within(poll(), timeout - (Date.now() - start));
        lastError = null;
      } catch (err) {
        if (err instanceof MailboxError) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  function notFoundMessage(
    filter: MailFilter,
    elapsed: number,
    polls: number,
    lastError: Error | null
  ): string {
    const all = [...mails.values()];
    const unreadable = all.filter((mail) => mail.error).length;

    return [
      `Mail not found after ${Math.round(elapsed / 1000)}s (${polls} polls).`,
      `Filter: ${describeFilter(filter)}`,
      `Mailbox has ${all.length} mails (${unreadable} unreadable).`,
      `Last API error: ${lastError?.message ?? "none"}`,
    ].join("\n");
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
