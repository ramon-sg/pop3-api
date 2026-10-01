import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createMailbox, MailboxError } from "../../client/src/index.js";
import { PASSWORD, USER, rawMail, startFakeGmail } from "./fake-gmail";
import { startServer } from "./server";

/**
 * End to end: client → pop3-api (real process) → POP3 server with Gmail
 * semantics. What matters is that no mail is ever lost: every mail the fake
 * Gmail commits as delivered must have reached the client.
 */

let gmail: ReturnType<typeof startFakeGmail>;
let server: Awaited<ReturnType<typeof startServer>>;

beforeEach(async () => {
  gmail = startFakeGmail();
  server = await startServer(gmail.port);
});

afterEach(() => {
  server.stop();
  gmail.stop();
});

const mailbox = (overrides: Partial<Parameters<typeof createMailbox>[0]> = {}) =>
  createMailbox({
    url: server.url,
    username: USER,
    password: PASSWORD,
    wait: { interval: 50, timeout: 5_000 },
    ...overrides,
  });

const get = () =>
  fetch(server.url, {
    headers: { "X-POP3-USERNAME": USER, "X-POP3-PASSWORD": PASSWORD },
  });

describe("pop3-api end to end", () => {
  test("mails reach the client once and are committed in Gmail", async () => {
    const box = mailbox();
    const to = box.alias();
    gmail.deliver(rawMail({ to, subject: "Listo para despacho" }));
    gmail.deliver(rawMail({ to, subject: "En camino" }));

    expect((await box.waitFor({ to, subject: /listo/i })).subject).toBe("Listo para despacho");
    // Came in the same poll: found in memory, no new poll needed.
    expect((await box.waitFor({ to, subject: /camino/i })).subject).toBe("En camino");
    expect(gmail.pending()).toBe(0);
    expect(gmail.sessions).toHaveLength(1);
  });

  test("waitFor keeps polling until the mail arrives", async () => {
    const box = mailbox();
    const to = box.alias();
    setTimeout(() => gmail.deliver(rawMail({ to, subject: "Bienvenido" })), 300);

    expect((await box.waitFor({ to })).subject).toBe("Bienvenido");
    expect(gmail.sessions.length).toBeGreaterThan(1);
  });

  test("a connection dropped mid-poll commits nothing and the mails come back", async () => {
    gmail.deliver(rawMail({ to: "a@gmail.com", subject: "One" }));
    gmail.deliver(rawMail({ to: "a@gmail.com", subject: "Two" }));
    gmail.setFault({ kind: "close", onRetr: 2 });

    const failed = await get();
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({
      success: false,
      error: "POP3 server closed the connection",
    });
    expect(gmail.sessions[0]).not.toContain("QUIT");
    expect(gmail.pending()).toBe(2);

    gmail.setFault(null);
    const box = mailbox();
    expect((await box.waitFor({ subject: "One" })).subject).toBe("One");
    expect(box.find({ subject: "Two" })).toBeDefined();
    expect(gmail.pending()).toBe(0);
  });

  test("a hung server answers 504, commits nothing, and the client retries", async () => {
    gmail.deliver(rawMail({ to: "a@gmail.com", subject: "Late" }));
    gmail.setFault({ kind: "hang", onRetr: 1 });

    const hung = await get();
    expect(hung.status).toBe(504);
    expect(gmail.pending()).toBe(1);

    gmail.setFault(null);
    expect((await mailbox().waitFor({ subject: "Late" })).subject).toBe("Late");
  });

  test("a client that gives up mid-poll does not lose the mails", async () => {
    gmail.deliver(rawMail({ to: "a@gmail.com", subject: "Slow" }));
    gmail.setFault({ kind: "slow", onRetr: 1, ms: 800 });

    // The request is aborted at 300 ms, while RETR is still running.
    const impatient = mailbox({ requestTimeout: 300 });
    await impatient.poll().catch(() => {});
    await Bun.sleep(900);

    expect(gmail.sessions[0]).not.toContain("QUIT");
    expect(gmail.pending()).toBe(1);

    gmail.setFault(null);
    expect((await mailbox().waitFor({ subject: "Slow" })).subject).toBe("Slow");
  });

  test("concurrent polls of one account share one session and its mails", async () => {
    gmail.deliver(rawMail({ to: "a@gmail.com", subject: "Shared" }));
    gmail.setFault({ kind: "slow", onRetr: 1, ms: 300 });

    const [a, b] = await Promise.all([mailbox().poll(), mailbox().poll()]);

    expect(a.map((m) => m.subject)).toEqual(["Shared"]);
    expect(b.map((m) => m.subject)).toEqual(["Shared"]);
    expect(gmail.sessions).toHaveLength(1);
  });

  test("a message Gmail refuses comes back with error and does not block the rest", async () => {
    gmail.deliver(rawMail({ to: "a@gmail.com", subject: "Broken" }));
    gmail.deliver(rawMail({ to: "a@gmail.com", subject: "Fine" }));
    gmail.setFault({ kind: "err", onRetr: 1 });

    const box = mailbox();
    expect((await box.waitFor({ subject: "Fine" })).subject).toBe("Fine");
    expect(box.all().map((m) => m.error ?? m.subject)).toEqual([
      "RETR failed: Message is unavailable",
      "Fine",
    ]);
  });

  test("bad credentials fail right away", async () => {
    const start = Date.now();
    const error = await mailbox({ password: "wrong" })
      .waitFor({}, { timeout: 30_000 })
      .catch((e) => e);

    expect(error).toBeInstanceOf(MailboxError);
    expect(error.message).toContain("[AUTH]");
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  test("dot-stuffed lines, links, codes and attachments survive the trip", async () => {
    const box = mailbox();
    const to = box.alias("verify");
    gmail.deliver(
      [
        "From: Shop <no-reply@shop.cl>",
        `To: ${to}`,
        "Subject: Verifica tu cuenta",
        `Message-ID: <${crypto.randomUUID()}@shop.cl>`,
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/html; charset=utf-8",
        "",
        '<p>Tu código es <b>482913</b></p><a href="https://shop.cl/verify?t=1&amp;u=2">Verificar</a>',
        ".line starting with a dot",
        "--b",
        'Content-Type: text/plain; name="a.txt"',
        "Content-Disposition: attachment; filename=a.txt",
        "Content-Transfer-Encoding: base64",
        "",
        "aGVsbG8=",
        "--b--",
      ].join("\r\n")
    );

    const mail = await box.waitFor({ to, subject: /verifica/i });

    expect(box.code(mail)).toBe("482913");
    expect(box.links(mail, /verify/)).toEqual(["https://shop.cl/verify?t=1&u=2"]);
    expect(mail.html).toContain(".line starting with a dot");
    expect(mail.attachments[0]!.content).toBe("aGVsbG8=");
  });
});
