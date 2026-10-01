import type { Fixtures } from "@playwright/test";

import { formatDiagnostics } from "./diagnostics.js";
import { createMailbox, type Mailbox } from "./mailbox.js";
import type { MailboxOptions } from "./types.js";

export type MailboxFixtures = { mailbox: Mailbox };

/** Test scoped helper of `mailboxFixture`; tests never use it directly. */
export type MailboxTestFixtures = { _mailboxDiagnostics: void };

/**
 * @description Worker scoped `mailbox` fixture. It lives for the whole worker,
 * so a mail that arrived during one test is still there for the next ones.
 *
 * When a test fails, the diagnostics of the `waitFor` calls it made are
 * attached to it (`mailbox`: text, `mailbox.json`): the mails received for
 * each address, every poll and what pop3-api reported. Only summaries, never
 * bodies nor attachments.
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
): Fixtures<MailboxTestFixtures, MailboxFixtures> {
  // The worker's mailbox, once a test asked for it. The diagnostics fixture
  // reads it instead of depending on `mailbox`, so tests that never use the
  // mailbox do not create it.
  let created: Mailbox | undefined;

  return {
    mailbox: [
      async ({}, use) => {
        created = createMailbox(
          typeof options === "function" ? options() : options
        );
        await use(created);
      },
      { scope: "worker" },
    ],

    _mailboxDiagnostics: [
      async ({}, use, testInfo) => {
        const since = created?.lastWaitId() ?? 0;
        await use();

        if (!created || testInfo.status === "passed" || testInfo.status === "skipped") {
          return;
        }

        const waits = created.history(since);
        if (!waits.length) return;

        await testInfo.attach("mailbox", {
          body: waits.map(formatDiagnostics).join("\n\n"),
          contentType: "text/plain",
        });
        await testInfo.attach("mailbox.json", {
          body: JSON.stringify(waits, null, 2),
          contentType: "application/json",
        });
      },
      { auto: true },
    ],
  };
}
