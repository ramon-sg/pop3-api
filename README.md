# pop3-api

This is a simple API that connects to a POP3 server and returns the emails in the inbox.
Used preferably for testing purposes.
Works very well with Pop3 Gmail.

It comes with a small [client](#client-for-e2e-tests) to wait for emails from E2E tests.


To install dependencies:

```bash
bun install
```

To run:

```bash
bun run start
```

To test:

```bash
bun run test
```

# Configuration:
To configure the server, you can use the following environment variables:
- `MAIL_PORT`: the port the server will connect to. Default is 995.
- `MAIL_HOST`: the host the server will connect to. Default is `pop.gmail.com`.
- `MAIL_TLS`: if the client will use TLS (`true`/`false`). Default is `true`.
- `MAIL_REJECT_UNAUTHORIZED`: if the client will reject unauthorized certificates (`true`/`false`). Default is `true`.
- `MAIL_TIMEOUT_MS`: max time to wait for each POP3 command. Default is `30000`.
- `LOG_LEVEL`: the log level of the server (`debug`, `info`, `warn`, `error`, `off`). Default is `info`.
  `info` logs a summary per email (`uidl`, `messageId`, `to`, `subject`, `date`); full bodies are only logged in `debug`.
- `PORT`: the port the server will listen to. Default is 3000.

# pop3-api
To obtain the emails it is necessary to make a query to `/` with the following headers:
- `X-POP3-USERNAME`: the email you want to check
- `X-POP3-PASSWORD`: the password of the email you want to check

The response will be a JSON with the emails in the inbox.

## Each email is delivered only once

With Gmail in normal POP mode every poll downloads **all** pending emails and
Gmail marks them as downloaded: the next poll will not return them again. Keep
every email you receive, not only the one you are looking for — the
[client](#client-for-e2e-tests) does this for you.

If a poll fails midway (auth error, timeout, dropped connection) the session is
closed **without** `QUIT`, so Gmail does not mark anything as downloaded and the
emails come back in the next poll.

## Success response

```json
{
  "success": true,
  "data": [
    {
      "uidl": "GmailId18f2c1a9b7e4d3c2",
      "from": {"name": "John Doe", "address": "john@mail.com"},
      "to": [
        { "name": "user one", "address": "one@mail.com"}
      ],
      "subject": "Hello",
      "html":  "<h1>Hello</h1>",
      "text": "Hello",
      "date": "2021-09-01T00:00:00.000Z"
      // ...
    }
  ]
}
```

**Note**: You can see the full attributes of the mail in `Mail` type in `src/mail/types.ts`.

An email that was downloaded but could not be read (empty or unparseable) is
still returned, with `error` and its raw `headers`, instead of being dropped:

```json
{ "uidl": "GmailId…", "error": "Unparseable message: …", "headers": "Subject: …", "attachments": [] }
```


## Error response

```json
{
  "success": false,
  "error": "Error message"
}
```

| Status | When |
| ------ | ---- |
| 400 | Missing `X-POP3-USERNAME` or `X-POP3-PASSWORD` |
| 502 | The POP3 server failed (e.g. `-ERR [AUTH] …`, connection refused) |
| 504 | The POP3 server did not answer within `MAIL_TIMEOUT_MS` |


## Curl example:
```bash
curl -X GET "http://localhost:3000/" -H "X-POP3-USERNAME: <email>" -H "X-POP3-PASSWORD: <password>"
```


## Docker
To run the server in a docker container, you can use the following command:

```bash
docker run -p 3000:3000 ramonsoto/pop3-api:v0.0.3
```

# Client (for E2E tests)

Dependency-free library to wait for emails from tests. It polls `pop3-api`,
keeps in memory **every** email it receives (not only the one you are waiting
for) and waits until one matches your filter.

## Installation

It is not published to npm. Install it from the GitHub Release:

```bash
pnpm add -D https://github.com/ramon-sg/pop3-api/releases/download/v0.0.3/pop3-api-client-0.0.3.tgz
```

## Basic usage

```ts
import { createMailbox } from 'pop3-api-client';

const mailbox = createMailbox({
  url: 'http://localhost:3033',          // where pop3-api runs
  username: 'tests@gmail.com',
  password: process.env.TEST_EMAIL_PASSWORD!,
});

// 1. A unique address for this test: tests+k3j9x0a1b2-1727712000000@gmail.com
const to = mailbox.alias();

// 2. Do something that sends an email to that address
await registerUser({ email: to });

// 3. Wait for the email (polls every 5 s, fails after 60 s)
const mail = await mailbox.waitFor({ to, subject: /bienvenid/i });

mail.subject;          // "¡Bienvenido!"
mail.from?.address;    // "no-reply@shop.cl"
mail.html;             // the full HTML
```

## `waitFor` filters

Every field is optional and they are combined with AND. Each one accepts a
string (exact match; addresses ignore case), a RegExp or a function.

```ts
await mailbox.waitFor({
  to: alias,                                    // any of the recipients
  from: 'no-reply@shop.cl',
  subject: /pedido/i,
  text: (t) => t.includes('#1234'),
  html: /href=".*\/verify/,
  where: (mail) => mail.attachments.length > 0, // free filter over the whole Mail
});
```

Unreadable emails (the ones with `error`) never match.

## Wait options

```ts
await mailbox.waitFor(filter, {
  timeout: 200_000,  // total ms before failing (default 60_000)
  interval: 5_000,   // ms between polls (default 5_000)
});

// Or set the defaults once:
createMailbox({ url, username, password, wait: { timeout: 200_000 } });
```

The timeout is checked between polls: a poll in progress is never aborted,
because the emails it brings would be lost.

If the email does not arrive it throws a readable error:

```
Mail not found after 200s (41 polls).
Filter: {"to":"tests+k3j9x…","subject":"/pedido/i"}
Mailbox has 3 mails (0 unreadable).
Last API error: none
```

Transient errors (network, 502, 504) are retried. Bad credentials
(`-ERR [AUTH]`) or a 4xx fail right away with a `MailboxError` instead of
waiting for the timeout.

## Links and codes

```ts
const mail = await mailbox.waitFor({ to, subject: /verifica/i });

const [verifyUrl] = mailbox.links(mail, /\/verify/); // hrefs of the HTML that match
await page.goto(verifyUrl!);

const code = mailbox.code(mail);                      // first 6 digit code
const pin = mailbox.code(mail, /PIN: (\d{4})/);       // or your own pattern (1st group)
```

## Other methods

```ts
mailbox.all();           // every email received so far (copy)
mailbox.find(filter);    // searches in memory without polling; Mail | undefined
await mailbox.poll();    // polls now and returns the new emails
mailbox.clear();         // forgets the emails in memory
```

## Playwright

A ready to use fixture is included. The mailbox is **worker scoped**: it lives
for the whole run, so an email that arrived during one test is still there for
the next ones.

```ts
// fixtures.ts
import { test as base } from '@playwright/test';
import { mailboxFixture } from 'pop3-api-client/playwright';

export const test = base.extend(
  mailboxFixture(() => ({
    url: process.env.MAIL_API_URL!,
    username: process.env.TEST_EMAIL!,
    password: process.env.TEST_EMAIL_PASSWORD!,
  })),
);
```

```ts
// register.spec.ts
import { test } from './fixtures';

test('sends the welcome email', async ({ page, mailbox }) => {
  const email = mailbox.alias();

  await page.goto('/registro');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Crear cuenta' }).click();

  const mail = await mailbox.waitFor({ to: email, subject: /bienvenid/i });
  await page.goto(mailbox.links(mail, /\/verify/)[0]!);
});
```

If your `extend` already has other fixtures, spread it and type the worker
fixture with `MailboxFixtures`:

```ts
import { mailboxFixture, type MailboxFixtures } from 'pop3-api-client/playwright';

export const test = base.extend<MyFixtures, MailboxFixtures>({
  ...mailboxFixture(() => ({ /* … */ })),
  apiClient: async ({ request }, use) => { /* … */ },
});
```

## Development

```bash
cd client
bun install
bun run test
bun run build     # dist/
bun pm pack       # pop3-api-client-<version>.tgz
```

# Release

Pushing a `v*` tag (e.g. `v0.0.3`) runs `.github/workflows/release.yml`: it
tests the server and the client, builds the client and attaches
`pop3-api-client-<version>.tgz` to the GitHub Release. The tag must match the
`version` of `package.json` and `client/package.json`.

The Docker image is still published by hand:

```bash
docker build -t ramonsoto/pop3-api:v0.0.3 .
docker push ramonsoto/pop3-api:v0.0.3
```

# Gmail Account

## Generate a password for the app, follow the steps below:
- activate the 2-step verification in your account.
- Go to the next link: [https://myaccount.google.com/apppasswords](https://myaccount.google.com/apppassword)

## Activate pop3 and disable imap, follow the steps below:
- Go to the next link: [https://mail.google.com/mail/u/0/#settings/fwdandpop](https://mail.google.com/mail/u/0/#settings/fwdandpop)

- in `POP Download` select `Enable POP for all mail (even mail that's already been downloaded)`
- in `IMAP Access` select `Disable IMAP`
