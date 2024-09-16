import { getMail } from "./mail";
import { logger } from "./logger";
import { config } from "./config";
import { nok, ok } from "./responder";
import { PASSWORD_KEY, USERNAME_KEY } from "./constants";

Bun.serve({
  port: config.port,
  async fetch(req) {
    if (req.method === "OPTIONS") {
      return ok("Departed");
    }

    const username = req.headers.get(USERNAME_KEY);
    const password = req.headers.get(PASSWORD_KEY);

    if (!username || !password) {
      return nok("Missing headers", { status: 400 });
    }

    const [error, mails] = await getMail({
      password,
      username,
    });

    return error ? nok(error.message) : ok(mails);
  },
});

logger.info("Config", config);

logger.info(`Server running on http://localhost:${config.port}`);
