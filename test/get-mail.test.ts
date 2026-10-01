import { EventEmitter } from "node:events";
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
  sizes?: number[];
};

function fakeClient({ messages, sizes = [] }: FakeOptions) {
  const calls = { quit: 0, destroyed: 0, retr: [] as number[] };

  const events = new EventEmitter();
  const client: Pop3Client & { emit: EventEmitter["emit"] } = {
    on: (event, listener) => events.on(event, listener),
    emit: (event, ...args) => events.emit(event, ...args),
    UIDL: async () => messages.map((_, i) => [String(i + 1), `uid-${i + 1}`]),
    LIST: async () =>
      messages.map((_, i) => [String(i + 1), String(sizes[i] ?? 100)]),
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

  test("a -ERR for one message is returned with error and the poll goes on", async () => {
    const serverError = Object.assign(new Error("Message deleted"), {
      eventName: "error",
      command: "RETR 2",
    });
    const { calls, create } = fakeClient({
      messages: [raw("Welcome"), serverError, raw("Bye")],
    });

    const [error, mails] = await getMail(credentials, create);

    expect(error).toBeNull();
    expect(mails!.map((m) => [m.uidl, m.subject ?? m.error])).toEqual([
      ["uid-1", "Welcome"],
      ["uid-2", "RETR failed: Message deleted"],
      ["uid-3", "Bye"],
    ]);
    expect(calls.quit).toBe(1);
  });

  test("beforeQuit gets the messages before QUIT, and never on a failed poll", async () => {
    const order: string[] = [];
    const ok = fakeClient({ messages: [raw("Welcome")] });
    const quit = ok.client.QUIT;
    ok.client.QUIT = async () => {
      order.push("QUIT");
      return quit();
    };

    await getMail(
      { ...credentials, beforeQuit: (mails) => order.push(`store ${mails.length}`) },
      ok.create
    );
    expect(order).toEqual(["store 1", "QUIT"]);

    const failed = fakeClient({ messages: [new Error("socket closed")] });
    let stored = false;
    await getMail({ ...credentials, beforeQuit: () => (stored = true) }, failed.create);
    expect(stored).toBe(false);
  });

  test("a -ERR message keeps its headers (from TOP) so it can reach its alias", async () => {
    const serverError = Object.assign(new Error("Message is unavailable"), {
      eventName: "error",
      command: "RETR 1",
    });
    const { client } = fakeClient({ messages: [serverError] });
    client.TOP = async () => "To: user+a@gmail.com\r\nSubject: Broken";

    const [, mails] = await getMail(credentials, () => client);

    expect(mails![0]).toMatchObject({
      uidl: "uid-1",
      error: "RETR failed: Message is unavailable",
      headers: "To: user+a@gmail.com\r\nSubject: Broken",
      subject: "Broken",
    });
  });

  test("a large message gets more time than a command", async () => {
    const previous = config.mail.timeoutMs;
    config.mail.timeoutMs = 20;

    try {
      // 5 KB → 20 ms + 100 ms; the message takes 60 ms.
      const slow = () =>
        new Promise<string>((resolve) => setTimeout(() => resolve(raw("Big")), 60));
      const { calls, create } = fakeClient({ messages: [slow], sizes: [5_000] });

      const [error, mails] = await getMail(credentials, create);

      expect(error).toBeNull();
      expect(mails![0]!.subject).toBe("Big");
      expect(calls.quit).toBe(1);
    } finally {
      config.mail.timeoutMs = previous;
    }
  });

  test("an aborted request closes the session without QUIT", async () => {
    const controller = new AbortController();
    const { calls, create } = fakeClient({
      messages: [
        raw("Welcome"),
        async () => {
          controller.abort();
          return raw("Bye");
        },
      ],
    });

    const [error, mails] = await getMail(
      { ...credentials, signal: controller.signal },
      create
    );

    expect(mails).toBeNull();
    expect(error!.message).toBe("Request aborted by the client");
    expect(calls.quit).toBe(0);
    expect(calls.destroyed).toBe(1);
  });

  test("a server that closes mid-session answers 502 right away", async () => {
    const { client, calls } = fakeClient({ messages: [raw("Welcome")] });
    client.RETR = () => {
      const closed = Object.assign(new Error("close"), { eventName: "close" });
      setTimeout(() => client.emit("warn", closed), 5);
      return new Promise(() => {});
    };

    const start = Date.now();
    const [error] = await getMail(credentials, () => client);

    expect(error!.status).toBe(502);
    expect(error!.message).toBe("POP3 server closed the connection");
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(calls.quit).toBe(0);
  });

  test("the library idle timeout answers 504, not the close it causes", async () => {
    const { client } = fakeClient({ messages: [raw("Welcome")] });
    client.RETR = () => {
      setTimeout(() => {
        client.emit("warn", Object.assign(new Error("timeout"), { eventName: "timeout" }));
        client.emit("warn", Object.assign(new Error("close"), { eventName: "close" }));
      }, 5);
      return new Promise(() => {});
    };

    const [error] = await getMail(credentials, () => client);

    expect(error!.status).toBe(504);
  });

  test("a socket error is reported with its cause, not as the close it causes", async () => {
    const { client } = fakeClient({ messages: [] });
    client.UIDL = () => {
      setTimeout(() => {
        const dns = Object.assign(new Error("getaddrinfo ETIMEOUT pop.gmail.com"), {
          eventName: "error",
        });
        client.emit("warn", dns);
        client.emit("warn", Object.assign(new Error("close"), { eventName: "close" }));
      }, 5);
      return new Promise(() => {});
    };

    const [error] = await getMail(credentials, () => client);

    expect(error!.status).toBe(502);
    expect(error!.message).toBe("getaddrinfo ETIMEOUT pop.gmail.com");
  });

  test("the close that follows QUIT is not an error", async () => {
    const { client, calls } = fakeClient({ messages: [raw("Welcome")] });
    client.QUIT = async () => {
      calls.quit++;
      client.emit("warn", Object.assign(new Error("end"), { eventName: "end" }));
      return "+OK";
    };

    const [error, mails] = await getMail(credentials, () => client);

    expect(error).toBeNull();
    expect(mails).toHaveLength(1);
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
