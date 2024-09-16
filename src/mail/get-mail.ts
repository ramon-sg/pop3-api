import Pop3Command from "node-pop3";

import type { Mail } from "./types";
import { parseMail } from "./parse-mail";

import { logger } from "../logger";
import { config } from "../config";

type GetMailOptions = {
  username: string;
  password: string;
};
/**
 * @description Get mails from a POP3 server
 * @example
 * ```ts
 * const mail = await getMail({
 *  user: 'user@gmail.com',
 *  password: 'password',
 *  host: 'pop.gmail.com',
 *  port: 995,
 *  tls: true,
 *  tlsOptions: {
 *   rejectUnauthorized: false,
 *  },
 * });
 * ```
 */
export async function getMail({
  password,
  username,
}: GetMailOptions): Promise<[Error, null] | [null, Mail[]]> {
  logger.info("Mail for ", username);

  const pop3 = new Pop3Command({
    user: username,
    password: password,
    host: config.mail.host,
    port: config.mail.port,
    tls: config.mail.tls,
    tlsOptions: {
      rejectUnauthorized: config.mail.rejectUnauthorized,
    },
  });

  pop3.on("error", (err) => {
    logger.error(err);
  });

  pop3.on("connect", () => {
    logger.info("connect", "Connected to POP3 server");
  });

  pop3.on("close", () => {
    logger.info("close", "Disconnected from POP3 server");
  });

  try {
    const mails = await getMailFromServer(pop3);
    logger.info("Mails", mails);
    return [null, mails];
  } catch (err) {
    logger.error(err);
    return [err as Error, null];
  } finally {
    logger.info("finally", "Closing connection to POP3 server");
    await pop3.QUIT();
  }
}

async function getMailFromServer(pop3: Pop3Command): Promise<Mail[]> {
  const mails: Mail[] = [];
  const list = await pop3.LIST();

  logger.info("List", list);

  for (const item of list) {
    const msgNum = [item].flat()[0];
    const str = await pop3.RETR(+msgNum);

    const mail = await parseMail(str);

    if (!mail) {
      logger.error("Email not found", msgNum);
      continue;
    }

    mails.push(mail);
  }

  return mails;
}
