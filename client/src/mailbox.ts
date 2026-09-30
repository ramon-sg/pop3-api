import { describeFilter, matches } from "./match.js";
import type {
  ApiResponse,
  Mail,
  MailFilter,
  MailboxOptions,
  WaitOptions,
} from "./types.js";

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_INTERVAL = 5_000;
const DEFAULT_CODE = /\b\d{6}\b/;

export type Mailbox = ReturnType<typeof createMailbox>;

/**
 * @description Error that retrying cannot fix (bad credentials, missing
 * headers). `waitFor` fails right away instead of waiting for the timeout.
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
  const request = options.fetch ?? fetch;
  const mails = new Map<string, Mail>();
  let inflight: Promise<Mail[]> | null = null;

  /**
   * @description Unique address for one test, built with the `+` alias that
   * Gmail delivers to the same inbox: `user+k3j9x0a1b2-1727712000000@gmail.com`.
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
    });

    const body = (await res.json().catch(() => null)) as ApiResponse | null;

    if (!body) {
      throw new Error(`pop3-api answered ${res.status} without JSON`);
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

  /** @description Searches the stored mails without polling. */
  function find(filter: MailFilter = {}): Mail | undefined {
    for (const mail of mails.values()) {
      if (matches(mail, filter)) return mail;
    }
    return undefined;
  }

  /**
   * @description Waits for a mail that matches `filter`: looks in memory first
   * and polls until one arrives or `timeout` passes.
   *
   * Transient errors (network, 502, 504) are retried; bad credentials fail
   * right away. The timeout is checked between polls: a poll in progress is
   * never aborted, because the mails it brings would be lost.
   */
  async function waitFor(
    filter: MailFilter = {},
    waitOptions: WaitOptions = {}
  ): Promise<Mail> {
    const timeout =
      waitOptions.timeout ?? options.wait?.timeout ?? DEFAULT_TIMEOUT;
    const interval =
      waitOptions.interval ?? options.wait?.interval ?? DEFAULT_INTERVAL;
    const start = Date.now();
    let polls = 0;
    let lastError: Error | null = null;

    while (true) {
      const found = find(filter);
      if (found) return found;

      const elapsed = Date.now() - start;
      if (elapsed >= timeout && polls > 0) {
        throw new Error(notFoundMessage(filter, elapsed, polls, lastError));
      }

      if (polls > 0) {
        await sleep(Math.min(interval, timeout - elapsed));
      }

      polls++;
      try {
        await poll();
        lastError = null;
      } catch (err) {
        if (err instanceof MailboxError) throw err;
        lastError = err as Error;
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
   * @description `href`s of the mail's HTML (or URLs of its text when it has no
   * HTML), optionally filtered.
   */
  function links(mail: Mail, filter?: RegExp | string): string[] {
    const found = mail.html
      ? [...mail.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!)
      : [...(mail.text ?? "").matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map(
          // A URL at the end of a sentence carries its punctuation.
          (m) => m[0].replace(/[.,;:!?]+$/, "")
        );

    const decoded = found.map((href) => href.replace(/&amp;/g, "&"));

    if (filter === undefined) return decoded;

    return decoded.filter((href) =>
      typeof filter === "string" ? href.includes(filter) : new RegExp(filter).test(href)
    );
  }

  /**
   * @description First match of `pattern` in the text (or HTML) of the mail. By
   * default a 6 digit code. Returns the first capture group if there is one.
   */
  function code(mail: Mail, pattern: RegExp = DEFAULT_CODE): string | undefined {
    const source = mail.text || mail.html?.replace(/<[^>]+>/g, " ") || "";
    const match = source.match(new RegExp(pattern.source, pattern.flags.replace("g", "")));

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
    clear: (): void => mails.clear(),
  };
}

function keyOf(mail: Mail): string {
  return (
    mail.uidl ??
    mail.messageId ??
    JSON.stringify([mail.date, mail.subject, mail.to, mail.error])
  );
}

/** Bad credentials or a bad request: waiting will not fix it. */
function isFatal(status: number, error: string): boolean {
  return (status >= 400 && status < 500) || /\[AUTH\]|authentication failed/i.test(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
