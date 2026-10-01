import type { Subprocess } from "bun";

/**
 * Starts the real pop3-api (`src/index.ts`) as a separate process against
 * `mailPort`, like it runs in Docker.
 */
export async function startServer(mailPort: number, env: Record<string, string> = {}) {
  const port = await freePort();
  const proc: Subprocess = Bun.spawn(["bun", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      MAIL_HOST: "127.0.0.1",
      MAIL_PORT: String(mailPort),
      MAIL_TLS: "false",
      MAIL_TIMEOUT_MS: "1000",
      LOG_LEVEL: "off",
      ...env,
    },
    stdout: "ignore",
    stderr: "inherit",
  });

  const url = `http://127.0.0.1:${port}`;
  await waitUntilUp(url);

  return { url, stop: () => proc.kill() };
}

async function waitUntilUp(url: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "OPTIONS" });
      if (res.ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`pop3-api did not start on ${url}`);
}

async function freePort(): Promise<number> {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
}
