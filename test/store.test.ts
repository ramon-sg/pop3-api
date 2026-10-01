import { describe, expect, test } from "bun:test";

import { MailStore, accountKey, recipients } from "../src/mail/store";
import type { Mail } from "../src/mail/types";

const mail = (uidl: string, to: string, extra: Partial<Mail> = {}): Mail => ({
  uidl,
  to: [{ name: "", address: to }],
  subject: uidl,
  attachments: [],
  ...extra,
});

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const key = accountKey("u@gmail.com", "pw");

describe("MailStore", () => {
  test("keeps mails per account, deduplicated by uidl", () => {
    const store = new MailStore(60_000, 100);

    expect(store.add(key, [mail("1", "a@gmail.com"), mail("2", "b@gmail.com")])).toBe(2);
    expect(store.add(key, [mail("2", "b@gmail.com"), mail("3", "a@gmail.com")])).toBe(1);

    expect(store.list(key).mails.map((m) => m.uidl)).toEqual(["1", "2", "3"]);
    expect(store.list(accountKey("u@gmail.com", "other")).mails).toEqual([]);
  });

  test("filters by alias in to, cc, bcc and Delivered-To, ignoring case", () => {
    const store = new MailStore(60_000, 100);
    store.add(key, [
      mail("to", "Tests+A@gmail.com"),
      mail("cc", "x@gmail.com", { cc: [{ name: "", address: "tests+a@gmail.com" }] }),
      mail("bcc", "x@gmail.com", { to: [], deliveredTo: "tests+a@gmail.com" }),
      mail("other", "tests+b@gmail.com"),
    ]);

    const { mails, meta } = store.list(key, " TESTS+A@gmail.com ");

    expect(mails.map((m) => m.uidl)).toEqual(["to", "cc", "bcc"]);
    expect(meta.retained).toBe(3);
  });

  test("drops mails after the retention and counts them per alias", () => {
    const time = clock();
    const store = new MailStore(1_000, 100, time.now);
    store.add(key, [mail("1", "a@gmail.com"), mail("2", "b@gmail.com")]);
    time.advance(500);
    store.add(key, [mail("3", "a@gmail.com")]);
    time.advance(600);

    expect(store.list(key, "a@gmail.com").mails.map((m) => m.uidl)).toEqual(["3"]);
    expect(store.list(key, "a@gmail.com").meta.expired).toBe(1);
    expect(store.list(key, "b@gmail.com").meta.expired).toBe(1);
    expect(store.list(key, "c@gmail.com").meta.expired).toBe(0);
    expect(store.list(key).meta.expired).toBe(2);
  });

  test("keeps at most `max` mails per account, dropping the oldest", () => {
    const store = new MailStore(60_000, 2);
    store.add(key, [mail("1", "a@gmail.com"), mail("2", "a@gmail.com"), mail("3", "a@gmail.com")]);

    expect(store.list(key).mails.map((m) => m.uidl)).toEqual(["2", "3"]);
    expect(store.list(key, "a@gmail.com").meta.expired).toBe(1);
  });

  test("reports the last poll and the retention", () => {
    const store = new MailStore(60_000, 100);
    expect(store.list(key).meta).toEqual({
      retained: 0,
      expired: 0,
      lastPoll: null,
      retentionMs: 60_000,
    });

    const lastPoll = { at: "2026-10-01T00:00:00.000Z", durationMs: 120, newMails: 2 };
    store.recordPoll(key, lastPoll);

    expect(store.list(key).meta.lastPoll).toEqual(lastPoll);
  });
});

describe("recipients", () => {
  test("reads the raw headers of an unreadable mail, folded or not", () => {
    const unreadable: Mail = {
      uidl: "x",
      error: "Unparseable message: boom",
      headers: [
        "Subject: Hi",
        'To: "Tests" <Tests+A@gmail.com>,',
        " other@gmail.com",
        "Cc: c@gmail.com",
        "Delivered-To: tests+a@gmail.com",
        "Reply-To: nope@gmail.com",
      ].join("\r\n"),
      attachments: [],
    };

    expect([...recipients(unreadable)].sort()).toEqual([
      "c@gmail.com",
      "other@gmail.com",
      "tests+a@gmail.com",
    ]);
  });

  test("flattens address groups", () => {
    const grouped = mail("g", "x@gmail.com", {
      to: [{ name: "team", group: [{ name: "", address: "a@gmail.com" }] }],
    });

    expect([...recipients(grouped)]).toEqual(["a@gmail.com"]);
  });
});
