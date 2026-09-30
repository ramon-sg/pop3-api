import Pop3Command from "node-pop3";

import type { Mail } from "./types";
import { errorMail, parseMail, summarize } from "./parse-mail";

import { logger } from "../logger";
import { config } from "../config";

type GetMailOptions = {
  username: string;
  password: string;
  /**
   * Aborted when the HTTP caller goes away. Nobody would receive the mails,
   * so the session is closed without `QUIT`.
   */
  signal?: AbortSignal;
};

/**
 * Minimum transfer rate assumed for `RETR`: a message gets `MAIL_TIMEOUT_MS`
 * plus 1 ms per 50 bytes (50 KB/s), so a large message on a slow link is not
 * cut by the same timeout as a one-line command.
 */
const MIN_BYTES_PER_MS = 50;

/**
 * @description The subset of `Pop3Command` used here. Lets tests inject a fake
 * POP3 client.
 */
export type Pop3Client = Pick<Pop3Command, "UIDL" | "LIST" | "RETR" | "QUIT"> & {
  _socket?: { destroy(): void } | null;
  on?(
    event: "warn",
    listener: (err: Error & { eventName?: string }) => void
  ): unknown;
};

/** Runs one POP3 command, bounded by a timeout and by the connection. */
type Run = <T>(promise: Promise<T>, ms?: number) => Promise<T>;

export type CreateClient = (options: {
  username: string;
  password: string;
}) => Pop3Client;

/**
 * @description Error of a failed poll. `status` is the HTTP status to answer
 * with: 504 when the POP3 server timed out, 502 for anything else.
 */
export class PollError extends Error {
  constructor(message: string, readonly status: 502 | 504) {
    super(message);
    this.name = "PollError";
  }
}

const createPop3Client: CreateClient = ({ username, password }) => {
  const pop3 = new Pop3Command({
    user: username,
    password,
    host: config.mail.host,
    port: config.mail.port,
    tls: config.mail.tls,
    timeout: config.mail.timeoutMs,
    tlsOptions: {
      rejectUnauthorized: config.mail.rejectUnauthorized,
    },
  });

  pop3.on("warn", (err: Error & { eventName?: string }) => {
    // The library also reports the normal end of the session as a warning.
    if (err.eventName === "end" || err.eventName === "close") {
      logger.debug("POP3 connection", err.eventName);
      return;
    }

    logger.warn("POP3 warning", err.message);
  });

  return pop3;
};

/**
 * @description Downloads every pending message of the mailbox.
 *
 * Gmail marks messages as downloaded only when the session ends with `QUIT`.
 * So `QUIT` is sent only after every message was downloaded; if anything
 * fails midway the socket is destroyed without `QUIT` and Gmail keeps the
 * messages for the next poll.
 *
 * A message that cannot be retrieved (`-ERR`) or parsed does not abort the
 * poll: it is returned with `error`.
 *
 * @example
 * ```ts
 * const [error, mails] = await getMail({
 *   username: 'user@gmail.com',
 *   password: 'app-password',
 * });
 * ```
 */
export async function getMail(
  { password, username, signal }: GetMailOptions,
  createClient: CreateClient = createPop3Client
): Promise<[PollError, null] | [null, Mail[]]> {
  logger.info("Polling mailbox", username);

  const pop3 = createClient({ username, password });
  const session = watchClose(pop3);
  let mails: Mail[];

  try {
    mails = await getMailFromServer(pop3, session.run, signal);
    throwIfAborted(signal);
  } catch (err) {
    const error = toPollError(err);
    logger.error("Poll failed, closing without QUIT", error.message);
    pop3._socket?.destroy();
    return [error, null];
  }

  // The server closes the connection after QUIT: that is not an error.
  session.stop();

  try {
    await withTimeout(pop3.QUIT());
  } catch (err) {
    // The messages were already downloaded: return them anyway. If Gmail did
    // not commit the session they will show up again in the next poll.
    logger.warn("QUIT failed", (err as Error).message);
    pop3._socket?.destroy();
  }

  if (mails.length) {
    logger.info(`Received ${mails.length} mails`, mails.map(summarize));
  } else {
    logger.debug("Received 0 mails");
  }
  logger.debug("Mails", mails);

  return [null, mails];
}

async function getMailFromServer(
  pop3: Pop3Client,
  run: Run,
  signal?: AbortSignal
): Promise<Mail[]> {
  const mails: Mail[] = [];
  const uidls = (await run(pop3.UIDL())) as string[][];
  const sizes = new Map(
    ((await run(pop3.LIST())) as string[][]).map(([msgNum, size]) => [
      msgNum,
      Number(size) || 0,
    ])
  );

  logger.debug("UIDL", uidls);

  for (const [msgNum, uidl] of uidls) {
    throwIfAborted(signal);

    const size = sizes.get(msgNum!) ?? 0;
    const mail = await retrieve(pop3, run, Number(msgNum), uidl, size);

    if (mail.error) {
      logger.warn("Unreadable message", summarize(mail));
    }

    mails.push(mail);
  }

  return mails;
}

async function retrieve(
  pop3: Pop3Client,
  run: Run,
  msgNum: number,
  uidl: string | undefined,
  size: number
): Promise<Mail> {
  const timeoutMs = config.mail.timeoutMs + Math.ceil(size / MIN_BYTES_PER_MS);
  let raw: unknown;

  try {
    raw = await run(pop3.RETR(msgNum), timeoutMs);
  } catch (err) {
    // `-ERR` from the server for this message only (it carries `command`).
    // Anything else (timeout, socket) is a session error: abort the poll.
    if (err instanceof Error && "command" in err) {
      return errorMail(undefined, uidl, `RETR failed: ${err.message}`);
    }
    throw err;
  }

  return parseMail(String(raw ?? ""), uidl);
}

/**
 * @description node-pop3 does not reject a pending command when the server
 * closes the connection: it only emits `warn`. Without this, a dropped
 * connection would wait for `MAIL_TIMEOUT_MS` and answer 504.
 */
function watchClose(pop3: Pop3Client): { run: Run; stop(): void } {
  let stopped = false;
  const closed = new Promise<never>((_, reject) => {
    pop3.on?.("warn", (err) => {
      if (stopped) return;

      // The library warns the cause (`timeout`, a socket `error` such as a DNS
      // failure) and then closes the socket: report the cause, not the close.
      // The first warning wins.
      if (err.eventName === "timeout" || err.eventName === "error") {
        reject(toPollError(err));
      } else if (err.eventName === "end" || err.eventName === "close") {
        reject(new PollError("POP3 server closed the connection", 502));
      }
    });
  });
  // Nobody awaits it when the connection closes after the last command.
  closed.catch(() => {});

  return {
    run: (promise, ms) => Promise.race([withTimeout(promise, ms), closed]),
    stop: () => {
      stopped = true;
    },
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new PollError("Request aborted by the client", 502);
  }
}

/**
 * @description node-pop3 only times out an idle socket; a command can still
 * wait forever for a response. This bounds every command.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number = config.mail.timeoutMs
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error("timeout"), { eventName: "timeout" }));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function toPollError(err: unknown): PollError {
  if (err instanceof PollError) {
    return err;
  }

  const error = err as Error & { eventName?: string };
  const message = error?.message || String(err);

  if (error?.eventName === "timeout" || message === "timeout") {
    return new PollError(
      `POP3 server timed out after ${config.mail.timeoutMs}ms`,
      504
    );
  }

  return new PollError(message, 502);
}
