import Pop3Command from "node-pop3";

import type { Mail } from "./types";
import { parseMail, summarize } from "./parse-mail";

import { logger } from "../logger";
import { config } from "../config";

type GetMailOptions = {
  username: string;
  password: string;
};

/**
 * @description The subset of `Pop3Command` used here. Lets tests inject a fake
 * POP3 client.
 */
export type Pop3Client = Pick<Pop3Command, "UIDL" | "RETR" | "QUIT"> & {
  _socket?: { destroy(): void } | null;
};

export type CreateClient = (options: GetMailOptions) => Pop3Client;

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
    streamReadTimeout: config.mail.timeoutMs,
    tlsOptions: {
      rejectUnauthorized: config.mail.rejectUnauthorized,
    },
  });

  pop3.on("warn", (err: Error) => {
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
 * A message that cannot be parsed does not abort the poll: it is returned
 * with `error`.
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
  { password, username }: GetMailOptions,
  createClient: CreateClient = createPop3Client
): Promise<[PollError, null] | [null, Mail[]]> {
  logger.info("Polling mailbox", username);

  const pop3 = createClient({ username, password });
  let mails: Mail[];

  try {
    mails = await getMailFromServer(pop3);
  } catch (err) {
    const error = toPollError(err);
    logger.error("Poll failed, closing without QUIT", error.message);
    pop3._socket?.destroy();
    return [error, null];
  }

  try {
    await withTimeout(pop3.QUIT());
  } catch (err) {
    // The messages were already downloaded: return them anyway. If Gmail did
    // not commit the session they will show up again in the next poll.
    logger.warn("QUIT failed", (err as Error).message);
    pop3._socket?.destroy();
  }

  logger.info(`Received ${mails.length} mails`, mails.map(summarize));
  logger.debug("Mails", mails);

  return [null, mails];
}

async function getMailFromServer(pop3: Pop3Client): Promise<Mail[]> {
  const mails: Mail[] = [];
  const list = (await withTimeout(pop3.UIDL())) as string[][];

  logger.debug("UIDL", list);

  for (const [msgNum, uidl] of list) {
    const raw = await withTimeout(pop3.RETR(Number(msgNum)));
    const mail = await parseMail(String(raw ?? ""), uidl);

    if (mail.error) {
      logger.warn("Unreadable message", summarize(mail));
    }

    mails.push(mail);
  }

  return mails;
}

/**
 * @description node-pop3 only times out an idle socket; a command can still
 * wait forever for a response. This bounds every command.
 */
function withTimeout<T>(promise: Promise<T>): Promise<T> {
  const ms = config.mail.timeoutMs;
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
