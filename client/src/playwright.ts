import type { Fixtures } from "@playwright/test";

import { createMailbox, type Mailbox } from "./mailbox.js";
import type { MailboxOptions } from "./types.js";

export type MailboxFixtures = { mailbox: Mailbox };

/**
 * @description Worker scoped `mailbox` fixture. It lives for the whole worker,
 * so a mail that arrived during one test is still there for the next ones.
 *
 * Pass a function to read the options lazily (e.g. from env vars loaded by the
 * Playwright config).
 *
 * @example
 * ```ts
 * export const test = base.extend(
 *   mailboxFixture(() => ({
 *     url: process.env.MAIL_API_URL!,
 *     username: process.env.TEST_EMAIL!,
 *     password: process.env.TEST_EMAIL_PASSWORD!,
 *   })),
 * );
 * ```
 */
export function mailboxFixture(
  options: MailboxOptions | (() => MailboxOptions)
): Fixtures<{}, MailboxFixtures> {
  return {
    mailbox: [
      async ({}, use) => {
        await use(
          createMailbox(typeof options === "function" ? options() : options)
        );
      },
      { scope: "worker" },
    ],
  };
}
