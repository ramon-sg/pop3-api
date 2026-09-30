import type { Socket } from "bun";

/**
 * POP3 server that behaves like Gmail in normal POP mode: a message is handed
 * over by every session until one session RETRieves it AND ends with QUIT.
 * A session that ends without QUIT (dropped, destroyed) commits nothing.
 */

export type Fault =
  | { kind: "close"; onRetr: number }
  | { kind: "hang"; onRetr: number }
  | { kind: "err"; onRetr: number }
  | { kind: "slow"; onRetr: number; ms: number };

type Message = { uid: string; raw: string; delivered: boolean };

type Session = {
  buffer: string;
  user?: string;
  authed: boolean;
  snapshot: Message[];
  retrieved: Set<Message>;
  log: string[];
};

export const USER = "tests@gmail.com";
export const PASSWORD = "app-password";

export function startFakeGmail() {
  const messages: Message[] = [];
  const sessions: string[][] = [];
  let fault: Fault | null = null;
  let seq = 0;

  const server = Bun.listen<Session>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = {
          buffer: "",
          authed: false,
          snapshot: [],
          retrieved: new Set(),
          log: [],
        };
        sessions.push(socket.data.log);
        socket.write("+OK Gpop ready\r\n");
      },
      async data(socket, chunk) {
        const state = socket.data;
        state.buffer += chunk.toString();

        let end: number;
        while ((end = state.buffer.indexOf("\r\n")) !== -1) {
          const line = state.buffer.slice(0, end);
          state.buffer = state.buffer.slice(end + 2);
          await handle(socket, line);
        }
      },
      close(socket) {
        socket.data.log.push("CLOSE");
      },
    },
  });

  async function handle(socket: Socket<Session>, line: string) {
    const state = socket.data;
    const [command = "", arg] = line.split(" ");
    state.log.push(command === "PASS" ? "PASS" : line);

    const write = (text: string) => {
      // The client may already be gone (aborted, destroyed).
      try {
        socket.write(text);
      } catch {}
    };

    if (command === "USER") {
      state.user = arg;
      return write("+OK send PASS\r\n");
    }

    if (command === "PASS") {
      if (state.user !== USER || arg !== PASSWORD) {
        return write("-ERR [AUTH] Username and password not accepted.\r\n");
      }
      state.authed = true;
      state.snapshot = messages.filter((m) => !m.delivered);
      return write("+OK Welcome.\r\n");
    }

    if (command === "QUIT") {
      for (const message of state.retrieved) message.delivered = true;
      write("+OK Farewell.\r\n");
      return socket.end();
    }

    if (!state.authed) return write("-ERR not authenticated\r\n");

    if (command === "UIDL" || command === "LIST") {
      const lines = state.snapshot.map((m, i) =>
        command === "UIDL" ? `${i + 1} ${m.uid}` : `${i + 1} ${Buffer.byteLength(m.raw)}`
      );
      return write(`+OK\r\n${lines.map((l) => `${l}\r\n`).join("")}.\r\n`);
    }

    if (command === "RETR") {
      const index = Number(arg);
      const message = state.snapshot[index - 1];
      if (!message) return write("-ERR no such message\r\n");

      if (fault?.onRetr === index) {
        if (fault.kind === "close") return socket.end();
        if (fault.kind === "hang") return;
        if (fault.kind === "err") return write("-ERR Message is unavailable\r\n");
        if (fault.kind === "slow") await Bun.sleep(fault.ms);
      }

      state.retrieved.add(message);
      const body = message.raw
        .split("\r\n")
        .map((l) => (l.startsWith(".") ? `.${l}` : l))
        .join("\r\n");
      return write(`+OK message follows\r\n${body}\r\n.\r\n`);
    }

    write("-ERR unknown command\r\n");
  }

  return {
    port: server.port,
    /** Delivers a message to the inbox. */
    deliver(raw: string) {
      messages.push({ uid: `GmailId${++seq}`, raw, delivered: false });
    },
    /** Messages no session has committed with QUIT yet. */
    pending: () => messages.filter((m) => !m.delivered).length,
    /** Commands of every session, e.g. `["USER a", "PASS", "UIDL", …, "CLOSE"]`. */
    sessions,
    setFault(next: Fault | null) {
      fault = next;
    },
    stop: () => server.stop(true),
  };
}

export function rawMail({
  to,
  subject,
  text = `Body of ${subject}`,
  extraHeaders = [],
}: {
  to: string;
  subject: string;
  text?: string;
  extraHeaders?: string[];
}): string {
  return [
    "From: Shop <no-reply@shop.cl>",
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${crypto.randomUUID()}@shop.cl>`,
    "Content-Type: text/plain; charset=utf-8",
    ...extraHeaders,
    "",
    text,
  ].join("\r\n");
}
