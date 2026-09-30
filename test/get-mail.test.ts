import { describe, expect, test } from "bun:test";

import { config } from "../src/config";
import { getMail, type Pop3Client } from "../src/mail/get-mail";

const raw = (subject: string, to = "user+a@gmail.com") =>
  [
    `From: No Reply <no-reply@shop.cl>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${subject.replace(/\s/g, "-")}@shop.cl>`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Body of ${subject}`,
  ].join("\r\n");

type FakeOptions = {
  messages: (string | Error | (() => Promise<string>))[];
};

function fakeClient({ messages }: FakeOptions) {
  const calls = { quit: 0, destroyed: 0, retr: [] as number[] };

  const client: Pop3Client = {
    UIDL: async () => messages.map((_, i) => [String(i + 1), `uid-${i + 1}`]),
    RETR: async (msgNum: number) => {
      calls.retr.push(msgNum);
      const message = messages[msgNum - 1];
      if (message instanceof Error) throw message;
      if (typeof message === "function") return message();
      return message!;
    },
    QUIT: async () => {
      calls.quit++;
      return "+OK";
    },
    _socket: { destroy: () => void calls.destroyed++ },
  };

  return { client, calls, create: () => client };
}

const credentials = { username: "user@gmail.com", password: "secret" };

describe("getMail", () => {
  test("returns every message with its uidl and sends QUIT", async () => {
    const { calls, create } = fakeClient({
      messages: [raw("Welcome"), raw("Order confirmed")],
    });

    const [error, mails] = await getMail(credentials, create);

    expect(error).toBeNull();
    expect(mails!.map((m) => [m.uidl, m.subject])).toEqual([
      ["uid-1", "Welcome"],
      ["uid-2", "Order confirmed"],
    ]);
    expect(calls.quit).toBe(1);
    expect(calls.destroyed).toBe(0);
  });

  test("a failing RETR closes the socket WITHOUT QUIT and answers 502", async () => {
    const { calls, create } = fakeClient({
      messages: [raw("Welcome"), new Error("-ERR connection reset")],
    });

    const [error, mails] = await getMail(credentials, create);

    expect(mails).toBeNull();
    expect(error!.status).toBe(502);
    expect(error!.message).toContain("connection reset");
    expect(calls.quit).toBe(0);
    expect(calls.destroyed).toBe(1);
  });

  test("an auth error on UIDL answers 502 without QUIT", async () => {
    const { client, calls } = fakeClient({ messages: [] });
    client.UIDL = async () => {
      throw new Error("-ERR [AUTH] Username and password not accepted.");
    };

    const [error] = await getMail(credentials, () => client);

    expect(error!.status).toBe(502);
    expect(error!.message).toContain("[AUTH]");
    expect(calls.quit).toBe(0);
  });

  test("a hanging command times out with 504 and no QUIT", async () => {
    const previous = config.mail.timeoutMs;
    config.mail.timeoutMs = 20;

    try {
      const { calls, create } = fakeClient({
        messages: [() => new Promise<string>(() => {})],
      });

      const [error] = await getMail(credentials, create);

      expect(error!.status).toBe(504);
      expect(calls.quit).toBe(0);
      expect(calls.destroyed).toBe(1);
    } finally {
      config.mail.timeoutMs = previous;
    }
  });

  test("an empty message is returned with error instead of skipped", async () => {
    const { calls, create } = fakeClient({
      messages: [raw("Welcome"), "", raw("Bye")],
    });

    const [error, mails] = await getMail(credentials, create);

    expect(error).toBeNull();
    expect(mails).toHaveLength(3);
    expect(mails![1]).toMatchObject({ uidl: "uid-2", error: "Empty message" });
    expect(mails![2]!.subject).toBe("Bye");
    expect(calls.quit).toBe(1);
  });

  test("a failed QUIT still returns the downloaded messages", async () => {
    const { client, calls } = fakeClient({ messages: [raw("Welcome")] });
    client.QUIT = async () => {
      throw new Error("socket closed");
    };

    const [error, mails] = await getMail(credentials, () => client);

    expect(error).toBeNull();
    expect(mails).toHaveLength(1);
    expect(calls.destroyed).toBe(1);
  });
});
