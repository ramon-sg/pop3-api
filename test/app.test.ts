import { describe, expect, test } from "bun:test";

import { createHandler } from "../src/app";
import { PollError } from "../src/mail/get-mail";
import { MailStore, accountKey } from "../src/mail/store";
import type { Mail } from "../src/mail/types";

const mail = (uidl: string, to: string): Mail => ({
  uidl,
  to: [{ name: "", address: to }],
  subject: uidl,
  attachments: [],
});

type Poll = NonNullable<Parameters<typeof createHandler>[0]["poll"]>;

/** Fake poll: each call "downloads" the next batch, as getMail would. */
function fakePoll(batches: (Mail[] | PollError)[]): Poll {
  return (async ({ beforeQuit }) => {
    const batch = batches.shift() ?? [];
    if (batch instanceof PollError) return [batch, null];
    beforeQuit?.(batch);
    return [null, batch];
  }) as Poll;
}

const request = (query = "", password = "pw") =>
  new Request(`http://pop3-api.test/${query}`, {
    headers: { "X-POP3-USERNAME": "u@gmail.com", "X-POP3-PASSWORD": password },
  });

describe("handler", () => {
  test("a mail consumed by one alias's poll is handed later to its owner", async () => {
    const store = new MailStore(60_000, 100);
    const handle = createHandler({
      store,
      poll: fakePoll([[mail("1", "a@gmail.com"), mail("2", "b@gmail.com")], []]),
    });

    const forA = await (await handle(request("?to=a@gmail.com"))).json();
    const forB = await (await handle(request("?to=b@gmail.com"))).json();

    expect(forA.data.map((m: Mail) => m.uidl)).toEqual(["1"]);
    expect(forB.data.map((m: Mail) => m.uidl)).toEqual(["2"]);
    expect(forB.meta).toMatchObject({ retained: 1, expired: 0, retentionMs: 60_000 });
    expect(forB.meta.lastPoll).toMatchObject({ newMails: 0 });
  });

  test("without `to` it returns every retained mail of the account", async () => {
    const store = new MailStore(60_000, 100);
    const handle = createHandler({
      store,
      poll: fakePoll([[mail("1", "a@gmail.com"), mail("2", "b@gmail.com")]]),
    });

    const body = await (await handle(request())).json();

    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.meta.lastPoll).toMatchObject({ newMails: 2 });
  });

  test("a failed poll answers its status and hands out nothing", async () => {
    const store = new MailStore(60_000, 100);
    const handle = createHandler({
      store,
      poll: fakePoll([
        [mail("1", "a@gmail.com")],
        new PollError("-ERR [AUTH] Username and password not accepted.", 502),
      ]),
    });

    await handle(request("?to=a@gmail.com"));
    const res = await handle(request("?to=a@gmail.com"));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      success: false,
      error: "-ERR [AUTH] Username and password not accepted.",
    });
  });

  test("another password is another account: it never sees these mails", async () => {
    const store = new MailStore(60_000, 100);
    const handle = createHandler({
      store,
      poll: fakePoll([[mail("1", "a@gmail.com")], []]),
    });

    await handle(request("?to=a@gmail.com", "pw"));
    const other = await (await handle(request("?to=a@gmail.com", "other"))).json();

    expect(other.data).toEqual([]);
  });

  test("records the error of a failed poll in lastPoll", async () => {
    const store = new MailStore(60_000, 100);
    const handle = createHandler({
      store,
      poll: fakePoll([new PollError("POP3 server timed out after 30000ms", 504), []]),
    });

    await handle(request());
    expect(store.list(accountKey("u@gmail.com", "pw")).meta.lastPoll).toMatchObject({
      newMails: 0,
      error: "POP3 server timed out after 30000ms",
    });

    // The next successful poll replaces it.
    const body = await (await handle(request())).json();
    expect(body.meta.lastPoll.error).toBeUndefined();
  });
});
