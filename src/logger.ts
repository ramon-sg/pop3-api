import log4js from "log4js";

import { config } from "./config";

export const logger = log4js.getLogger();

logger.level = config.logLevel;
