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
bun run build
bun run start
```

To test:

```bash
bun run test        # unit + integration (see Testing)
```

# Configuration
To configure the server, you can use the following environment variables:
- `MAIL_PORT`: the port the server will connect to. Default is 995.
- `MAIL_HOST`: the host the server will connect to. Default is `pop.gmail.com`.
- `MAIL_TLS`: if the client will use TLS (`true`/`false`). Default is `true`.
- `MAIL_REJECT_UNAUTHORIZED`: if the client will reject unauthorized certificates (`true`/`false`). Default is `true`.
- `MAIL_TIMEOUT_MS`: max time to wait for each POP3 command. Default is `30000`.
  Downloading a message (`RETR`) gets 1 extra ms per 50 bytes of its size, so a large message on a slow link is not cut.
- `MAIL_RETENTION_MS`: how long the server keeps the emails it consumed (see [retention](#retention-and-to)). Default is `1800000` (30 min).
- `MAIL_RETENTION_MAX`: max emails kept per account; the oldest are dropped first. Default is `500`.
- `LOG_LEVEL`: the log level of the server (`debug`, `info`, `warn`, `error`, `off`). Default is `info`.
  `info` logs a summary per email (`uidl`, `messageId`, `to`, `subject`, `date`); full bodies are only logged in `debug`.
- `PORT`: the port the server will listen to. Default is 3000.

# Usage
To obtain the emails it is necessary to make a query to `/` with the following headers:
- `X-POP3-USERNAME`: the email you want to check
- `X-POP3-PASSWORD`: the password of the email you want to check

Add `?to=<address>` to get only the emails of that address:

```bash
curl "http://localhost:3000/?to=tests%2Babc@gmail.com" -H "X-POP3-USERNAME: <email>" -H "X-POP3-PASSWORD: <password>"
```

## Retention and `?to=`

With Gmail in normal POP mode every poll downloads **all** pending emails and
Gmail marks them as downloaded: the next poll will not return them again. So
the server keeps every email it consumed for `MAIL_RETENTION_MS` (per account,
at most `MAIL_RETENTION_MAX`) and every request answers with the retained
emails:

- With `?to=<address>`, only the emails delivered to it: it matches `to`, `cc`,
  `bcc` and `Delivered-To` ignoring case, and the raw headers of an unreadable
  email. A test that waits for its `+` alias gets its emails whoever polled the
  inbox: another test, another Playwright worker, a restarted one.
- Without `to`, every retained email of the account.

The emails are stored right before `QUIT`, and retained emails are only handed
to a request whose own poll logged in with the same username and password.

If a poll fails midway (auth error, timeout, dropped connection) **or the HTTP
caller goes away** before the response is sent, the session is closed
**without** `QUIT`, so Gmail does not mark anything as downloaded and the emails
come back in the next poll.

Concurrent requests with the same credentials share one POP3 session: they all
get the same emails, and the session is only abandoned (without `QUIT`) when
every caller went away.

> **One pop3-api per inbox.** Retention lives in the memory of one pop3-api.
> Two pop3-api instances polling the same inbox (e.g. a CI run and a local run)
> take each other's emails: whoever polls first keeps them.

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
  ],
  "meta": { "...": "see below" }
}
```

`meta` describes what the server knows about the requested address (or the
whole account without `to`):

```json
"meta": {
  "retained": 1,
  "expired": 0,
  "lastPoll": { "at": "2026-10-01T00:00:00.000Z", "durationMs": 812, "newMails": 3 },
  "retentionMs": 1800000
}
```

- `retained`: emails kept for it. `expired`: emails of it dropped by retention or by the cap.
- `lastPoll`: the last poll of the account, from any caller: when, how long, how many new emails, and `error` if it failed.

**Note**: You can see the full attributes of the mail in `Mail` type in `src/mail/types.ts`.
Attachment `content` is base64 encoded.

An email that was downloaded but could not be read (empty, unparseable, or
`RETR` answered `-ERR`) is still returned with `error` instead of being dropped.
When there are raw headers, they come in `headers`:

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
| 502 | The POP3 server failed (e.g. `-ERR [AUTH] …`, connection refused, DNS error, connection closed mid-session) |
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

Dependency-free library to wait for emails from tests. It polls `pop3-api`
until an email matches your filter. When the filter has a string `to`, it only
asks for that address (`?to=`); pop3-api keeps the emails it consumed, so the
email is there even if another process polled the inbox first.

Requires Node >= 20.19 (or Bun). It is an ES module that can also be
`require`d, so it works in CommonJS Playwright projects. For TypeScript use
`moduleResolution` `bundler`, `nodenext` or `node`; `node16` in a CommonJS
project rejects importing an ES module.

## Installation

It is not published to npm. Install it from the GitHub Release:

```bash
pnpm add -D https://github.com/ramon-sg/pop3-api/releases/download/v0.0.3/pop3-api-client-0.0.3.tgz
```

## Basic usage

```ts
import { createMailbox } from 'pop3-api-client';

const mailbox = createMailbox({
  url: 'http://localhost:3000',          // where pop3-api runs
  username: 'tests@gmail.com',
  password: process.env.TEST_EMAIL_PASSWORD!,
});

// 1. A unique address for this test: tests+k3j9x0a1b2-1727712000000@gmail.com
//    (mailbox.alias('signup') → tests+signup-k3j9x0a1b2-1727712000000@gmail.com)
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
`to` matches any address in `to`, `cc`, `bcc` or `Delivered-To` (where an alias
sent as BCC shows up).

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

**`waitFor` returns each email at most once.** Waiting again with the same filter
(e.g. after clicking "resend code") gets the next email, never the one you
already have. `find`, `all` and the fields of the returned `Mail` still let you
read any email again.

## Wait options

```ts
await mailbox.waitFor(filter, {
  timeout: 200_000,  // total ms before failing (default 60_000)
  interval: 5_000,   // ms between polls (default 5_000)
});

// Or set the defaults once:
createMailbox({ url, username, password, wait: { timeout: 200_000 } });
```

At the timeout `waitFor` stops waiting, but a poll in progress keeps running in
the background and its emails are stored for the next `waitFor`. A single
request to `pop3-api` is aborted after `requestTimeout` (default 120 s,
`createMailbox({ …, requestTimeout })`); `pop3-api` then closes the POP3 session
without `QUIT`, so nothing is lost.

Playwright's default test timeout (30 s) is shorter than the default `waitFor`
timeout (60 s): raise it with `test.setTimeout()` or pass a shorter `timeout`,
otherwise the test is killed before the readable error below.

If the email does not arrive it throws an error that says why:

```
Mail not found after 200s.
Filter: {"to":"tests+k3j9x…","subject":"/camino/i"}
Verdict: filter-mismatch — a mail for this address arrived, but it does not match the rest of the filter (subject, from, …).
Polls: 30 polls: 27 ok (1 with new mails), 3 errors: 3× "pop3-api answered 504: POP3 server timed out after 30000ms" from 16:58:10 to 16:58:40.
pop3-api: 1 retained, 0 expired for this address; last poll at 16:59:01 ok (812 ms, 0 new).
Mails for tests+k3j9x…@gmail.com (1):
  - "Tu pedido ABC está listo para despacho" from no-reply@shop.cl to tests+k3j9x…@gmail.com at 2026-10-01T16:57:02.000Z
```

| Verdict | Meaning |
| ------- | ------- |
| `filter-mismatch` | A mail for the address arrived, but the rest of the filter does not match (e.g. the template changed the subject). |
| `taken` | The mails for the address were already returned by an earlier `waitFor` (overlapping filters). |
| `unreadable` | A mail for the address arrived, but pop3-api could not read it (`error`). |
| `expired` | pop3-api consumed mails for the address, but they expired before this `waitFor` asked. |
| `never-arrived` | No mail for the address reached the inbox. Check the polls and their errors. |
| `no-match` | The filter has no string `to`: the last 10 mails received are listed instead. |

Every poll is listed, errors included (not only the last one). The mails are
only summarized: never their body nor attachments, which carry verification
links and codes.

Transient errors (network, 5xx, 408, 429) are retried. Bad credentials
(`-ERR [AUTH]`) and any other 4xx (e.g. a wrong URL) fail right away with a
`MailboxError` instead of waiting for the timeout. `createMailbox` throws right
away if `url`, `username` or `password` is empty.

## Links and codes

```ts
const mail = await mailbox.waitFor({ to, subject: /verifica/i });

const [verifyUrl] = mailbox.links(mail, /\/verify/); // hrefs of the HTML (or URLs of the text) that match
await page.goto(verifyUrl!);

const code = mailbox.code(mail);                      // first 6 digit code of the text (or HTML without CSS/scripts)
const pin = mailbox.code(mail, /PIN: (\d{4})/);       // or your own pattern (1st group)
```

## Other methods

```ts
mailbox.all();           // every email this mailbox received so far (copy)
mailbox.find(filter);    // searches them without polling, including taken ones; Mail | undefined
await mailbox.poll(to);  // polls now (only `to` when given) and returns the new emails
mailbox.meta();          // `meta` of the last poll (pop3-api >= 0.0.3)
mailbox.diagnostics(filter); // the report above as an object, for that filter
mailbox.history();       // diagnostics of the last 50 `waitFor` calls
mailbox.clear();         // forgets what it received
```

## Playwright

A ready to use fixture is included. The mailbox is **worker scoped**. Several
workers can share one pop3-api: each asks for its own alias and pop3-api keeps
the emails whoever polled (see [retention](#retention-and-to)). Within the
retention, a restarted worker loses nothing either.

When a test fails, the fixture attaches the diagnostics of the `waitFor` calls
that test made: `mailbox` (the text report) and `mailbox.json`. They show up in
the HTML report next to the trace.

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

# Testing

| Command | What it covers |
| ------- | -------------- |
| `bun run test` | Unit tests of the server, plus **integration tests** (`test/integration`): the client, the real server (as a separate process) and a POP3 server that behaves like Gmail (a message is only committed by a session that `RETR`s it and ends with `QUIT`). They check that no mail is lost when the connection drops, the server hangs, the caller gives up, or two callers poll at once. |
| `cd client && bun run test` | Unit tests of the client. |
| `cd client && bun run test:consumers` | Installs the packed client (the `.tgz` a release publishes) in ESM and CommonJS projects and runs `tsc` and Playwright there. Catches packaging bugs (`exports`, types). Needs node, npm and network. |

CI (`.github/workflows/ci.yml`) runs all of them and builds the Docker image on
every pull request.

# Release

Pushing a `v*` tag runs `.github/workflows/release.yml`: it runs every test,
builds the client, attaches `pop3-api-client-<version>.tgz` to the GitHub
Release and, when the `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` secrets are set,
pushes `ramonsoto/pop3-api:<tag>` (override the image with the `DOCKER_IMAGE`
repository variable). The tag must match the `version` of `package.json` and
`client/package.json`, and a published tarball or image is never replaced:
consumers pin the tarball hash in their lockfile. A fix needs a new version.

## Release candidates

Try a version in a consumer before releasing it:

1. Set the version to e.g. `0.0.3-rc.1` in both `package.json` files and push
   the tag `v0.0.3-rc.1`. The release is marked as a prerelease.
2. In the consumer, install
   `https://github.com/ramon-sg/pop3-api/releases/download/v0.0.3-rc.1/pop3-api-client-0.0.3-rc.1.tgz`
   and run image `ramonsoto/pop3-api:v0.0.3-rc.1`.
3. When it works, release `v0.0.3` the same way and switch the consumer to it.

To try local changes without any release:

```bash
docker build -t pop3-api:local .
(cd client && bun run build && bun pm pack)   # client/pop3-api-client-<version>.tgz
```

Without the Docker secrets, push the image by hand (both architectures, like
the workflow does):

```bash
docker buildx create --name pop3-api-release --use   # once
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ramonsoto/pop3-api:v0.0.3 --push .
```

# Gmail Account

## Generate a password for the app, follow the steps below:
- activate the 2-step verification in your account.
- Go to the next link: [https://myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)

## Activate pop3 and disable imap, follow the steps below:
- Go to the next link: [https://mail.google.com/mail/u/0/#settings/fwdandpop](https://mail.google.com/mail/u/0/#settings/fwdandpop)

- in `POP Download` select `Enable POP for all mail (even mail that's already been downloaded)`
- in `IMAP Access` select `Disable IMAP`
