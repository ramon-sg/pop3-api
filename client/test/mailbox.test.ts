import { describe, expect, test } from "bun:test";

import { createMailbox, MailboxError, type Mail } from "../src/index.js";

const mail = (overrides: Partial<Mail>): Mail => ({
  from: { name: "Shop", address: "no-reply@shop.cl" },
  to: [{ name: "", address: "user+a@gmail.com" }],
  subject: "Hello",
  text: "Hello",
  attachments: [],
  ...overrides,
});

type Reply = { status?: number; body: unknown } | Error;

/** Fake pop3-api: each call consumes the next reply (the last one repeats). */
function fakeApi(replies: Reply[]) {
  const calls: RequestInit[] = [];

  const fetch = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
    });
  }) as unknown as typeof globalThis.fetch;

  return { fetch, calls };
}

const ok = (...data: Mail[]) => ({ body: { success: true, data } });
const options = { url: "http://pop3", username: "user@gmail.com", password: "pw" };

describe("createMailbox", () => {
  test("sends the credentials as headers", async () => {
    const api = fakeApi([ok()]);
    await createMailbox({ ...options, fetch: api.fetch }).poll();

    expect(api.calls[0]!.headers).toEqual({
      "X-POP3-USERNAME": "user@gmail.com",
      "X-POP3-PASSWORD": "pw",
    });
  });

  test("keeps mails that did not match for later waits", async () => {
    const ready = mail({ uidl: "1", subject: "Listo para despacho" });
    const shipped = mail({ uidl: "2", subject: "En camino" });
    const api = fakeApi([ok(ready, shipped), ok()]);
    const mailbox = createMailbox({ ...options, fetch: api.fetch });

    expect(await mailbox.waitFor({ subject: /listo/i })).toEqual(ready);
    expect(await mailbox.waitFor({ subject: /camino/i })).toEqual(shipped);
    expect(api.calls).toHaveLength(1);
  });

  test("polls until the mail arrives", async () => {
    const welcome = mail({ uidl: "1", subject: "Bienvenido" });
    const api = fakeApi([ok(), ok(), ok(welcome)]);
    const mailbox = createMailbox({ ...options, fetch: api.fetch });

    const found = await mailbox.waitFor(
      { subject: /bienvenid/i },
      { interval: 1, timeout: 1_000 }
    );

    expect(found).toEqual(welcome);
    expect(api.calls).toHaveLength(3);
  });

  test("dedupes by uidl, then messageId", async () => {
    const a = mail({ uidl: "1" });
    const b = mail({ messageId: "<b@shop.cl>" });
    const api = fakeApi([ok(a, b), ok(a, b, mail({ uidl: "3" }))]);
    const mailbox = createMailbox({ ...options, fetch: api.fetch });

    expect(await mailbox.poll()).toHaveLength(2);
    expect(await mailbox.poll()).toHaveLength(1);
    expect(mailbox.all()).toHaveLength(3);
  });

  test("concurrent polls share one request", async () => {
    const api = fakeApi([ok(mail({ uidl: "1" }))]);
    const mailbox = createMailbox({ ...options, fetch: api.fetch });

    await Promise.all([mailbox.poll(), mailbox.poll()]);

    expect(api.calls).toHaveLength(1);
  });

  test("retries transient errors", async () => {
    const welcome = mail({ uidl: "1" });
    const api = fakeApi([
      new TypeError("fetch failed"),
      { status: 504, body: { success: false, error: "timed out" } },
      ok(welcome),
    ]);
    const mailbox = createMailbox({ ...options, fetch: api.fetch });

    expect(await mailbox.waitFor({}, { interval: 1, timeout: 1_000 })).toEqual(welcome);
  });

  test("fails right away on bad credentials", async () => {
    const api = fakeApi([
      {
        status: 502,
        body: { success: false, error: "-ERR [AUTH] Username and password not accepted." },
      },
    ]);
    const mailbox = createMailbox({ ...options, fetch: api.fetch });

    await expect(mailbox.waitFor({}, { interval: 1, timeout: 60_000 })).rejects.toBeInstanceOf(
      MailboxError
    );
    expect(api.calls).toHaveLength(1);
  });

  test("detects bad credentials from pop3-api 0.0.2 (HTTP 200)", async () => {
    const api = fakeApi([{ body: { success: false, error: "-ERR [AUTH] nope" } }]);
    const mailbox = createMailbox({ ...options, fetch: api.fetch });

    await expect(mailbox.poll()).rejects.toBeInstanceOf(MailboxError);
  });

  test("times out with a readable message", async () => {
    const api = fakeApi([
      ok(mail({ uidl: "1" }), mail({ uidl: "2", error: "Empty message" })),
      { status: 502, body: { success: false, error: "socket closed" } },
    ]);
    const mailbox = createMailbox({ ...options, fetch: api.fetch });

    const error = await mailbox
      .waitFor({ subject: /nunca/i }, { interval: 5, timeout: 20 })
      .catch((e: Error) => e);

    expect((error as Error).message).toMatch(
      /Mail not found after \d+s \(\d+ polls\)\.\nFilter: \{"subject":"\/nunca\/i"\}\nMailbox has 2 mails \(1 unreadable\)\.\nLast API error: pop3-api answered 502: socket closed/
    );
  });
});

describe("filters", () => {
  const mailbox = createMailbox({ ...options, fetch: fakeApi([ok()]).fetch });

  test("to matches any recipient ignoring case", async () => {
    const api = fakeApi([
      ok(
        mail({
          uidl: "1",
          to: [
            { name: "", address: "other@gmail.com" },
            { name: "", address: "User+X@gmail.com" },
          ],
        })
      ),
    ]);
    const box = createMailbox({ ...options, fetch: api.fetch });
    await box.poll();

    expect(box.find({ to: "user+x@gmail.com" })).toBeDefined();
    expect(box.find({ to: "nobody@gmail.com" })).toBeUndefined();
  });

  test("combines fields with AND and supports where", async () => {
    const api = fakeApi([
      ok(mail({ uidl: "1", subject: "Pedido #1234", text: "Gracias" })),
    ]);
    const box = createMailbox({ ...options, fetch: api.fetch });
    await box.poll();

    expect(box.find({ subject: /pedido/i, from: "no-reply@shop.cl" })).toBeDefined();
    expect(box.find({ subject: /pedido/i, from: "other@shop.cl" })).toBeUndefined();
    expect(box.find({ text: (t) => t.includes("Gracias") })).toBeDefined();
    expect(box.find({ where: (m) => m.attachments.length > 0 })).toBeUndefined();
  });

  test("never matches unreadable mails", async () => {
    const api = fakeApi([ok(mail({ uidl: "1", error: "Empty message" }))]);
    const box = createMailbox({ ...options, fetch: api.fetch });
    await box.poll();

    expect(box.find()).toBeUndefined();
  });

  test("alias builds a unique + address", () => {
    expect(mailbox.alias()).toMatch(/^user\+[a-z0-9]+-\d+@gmail\.com$/);
    expect(mailbox.alias("signup")).toMatch(/^user\+signup-[a-z0-9]+-\d+@gmail\.com$/);
    expect(mailbox.alias()).not.toBe(mailbox.alias());
  });

  test("links reads hrefs and decodes &amp;", () => {
    const m = mail({
      html: '<a href="https://shop.cl/verify?t=1&amp;u=2">Verify</a><a href="https://shop.cl/help">Help</a>',
    });

    expect(mailbox.links(m)).toEqual(["https://shop.cl/verify?t=1&u=2", "https://shop.cl/help"]);
    expect(mailbox.links(m, /\/verify/)).toEqual(["https://shop.cl/verify?t=1&u=2"]);
    expect(mailbox.links(m, "help")).toEqual(["https://shop.cl/help"]);
  });

  test("links falls back to URLs in the text", () => {
    expect(mailbox.links(mail({ text: "Entra a https://shop.cl/verify?t=1." }))).toEqual([
      "https://shop.cl/verify?t=1",
    ]);
  });

  test("code finds a 6 digit code or a custom pattern", () => {
    expect(mailbox.code(mail({ text: "Tu código es 482913" }))).toBe("482913");
    expect(mailbox.code(mail({ text: "PIN: 1234" }), /PIN: (\d{4})/)).toBe("1234");
    expect(mailbox.code(mail({ text: undefined, html: "<b>904211</b>" }))).toBe("904211");
    expect(mailbox.code(mail({ text: "sin código" }))).toBeUndefined();
  });
});
