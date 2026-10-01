import { describe, expect, test } from "bun:test";

import { sharedPoll } from "../src/mail/shared-poll";
import type { Mail } from "../src/mail/types";

type Result = [null, Mail[]];

function fakePoll() {
  const calls: { signal?: AbortSignal; resolve: (r: Result) => void }[] = [];

  const poll = (options: { signal?: AbortSignal }) =>
    new Promise<Result>((resolve) => {
      calls.push({ signal: options.signal, resolve });
    });

  return { poll: poll as any, calls };
}

const mails: Mail[] = [{ uidl: "1", subject: "Hi", attachments: [] }];

describe("sharedPoll", () => {
  test("concurrent requests of one account share one poll and its mails", async () => {
    const { poll, calls } = fakePoll();
    const a = sharedPoll({ username: "u@gmail.com", password: "pw" }, poll);
    const b = sharedPoll({ username: "u@gmail.com", password: "pw" }, poll);

    expect(calls).toHaveLength(1);
    calls[0]!.resolve([null, mails]);

    expect(await a).toEqual([null, mails]);
    expect(await b).toEqual([null, mails]);
  });

  test("a new request after the poll ended starts a new poll", async () => {
    const { poll, calls } = fakePoll();
    const a = sharedPoll({ username: "u2@gmail.com", password: "pw" }, poll);
    calls[0]!.resolve([null, []]);
    await a;

    sharedPoll({ username: "u2@gmail.com", password: "pw" }, poll);

    expect(calls).toHaveLength(2);
  });

  test("a different password never joins the poll", () => {
    const { poll, calls } = fakePoll();
    sharedPoll({ username: "u3@gmail.com", password: "right" }, poll);
    sharedPoll({ username: "u3@gmail.com", password: "wrong" }, poll);

    expect(calls).toHaveLength(2);
  });

  test("the poll is aborted only when every caller went away", () => {
    const { poll, calls } = fakePoll();
    const first = new AbortController();
    const second = new AbortController();
    sharedPoll({ username: "u4@gmail.com", password: "pw", signal: first.signal }, poll);
    sharedPoll({ username: "u4@gmail.com", password: "pw", signal: second.signal }, poll);

    first.abort();
    expect(calls[0]!.signal!.aborted).toBe(false);

    second.abort();
    expect(calls[0]!.signal!.aborted).toBe(true);
  });

  test("joining with an already aborted signal does not keep the poll alive", () => {
    const { poll, calls } = fakePoll();
    const aborted = AbortSignal.abort();
    sharedPoll({ username: "u5@gmail.com", password: "pw", signal: aborted }, poll);

    expect(calls[0]!.signal!.aborted).toBe(true);
  });
});
