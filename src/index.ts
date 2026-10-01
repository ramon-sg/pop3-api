import { createHandler } from "./app";
import { logger } from "./logger";
import { config } from "./config";
import { MailStore } from "./mail/store";

const store = new MailStore(config.mail.retentionMs, config.mail.retentionMax);

Bun.serve({
  port: config.port,
  idleTimeout: 0,
  fetch: createHandler({ store }),
});

logger.info("Config", config);

logger.info(`Server running on http://localhost:${config.port}`);
