const LOG_LEVELS = ["all", "trace", "debug", "info", "warn", "error", "fatal", "off"];

export const config = {
  logLevel: logLevel(process.env.LOG_LEVEL, "info"),
  port: number(process.env.PORT, 3000),

  mail: {
    host: process.env.MAIL_HOST || "pop.gmail.com",
    port: number(process.env.MAIL_PORT, 995),
    tls: boolean(process.env.MAIL_TLS, true),
    rejectUnauthorized: boolean(process.env.MAIL_REJECT_UNAUTHORIZED, true),
    timeoutMs: number(process.env.MAIL_TIMEOUT_MS, 30_000),
    retentionMs: number(process.env.MAIL_RETENTION_MS, 30 * 60_000),
    retentionMax: number(process.env.MAIL_RETENTION_MAX, 500),
  },
};

/**
 * @description A positive integer, or the default. Partial values like `30s`
 * are rejected instead of being read as `30`.
 */
export function number(value: string | undefined, defaultValue: number): number {
  if (!value || !/^\d+$/.test(value.trim())) {
    return defaultValue;
  }

  const parsed = parseInt(value, 10);

  return parsed > 0 ? parsed : defaultValue;
}

export function boolean(
  value: string | undefined,
  defaultValue: boolean
): boolean {
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();

  if (["true", "1", "yes"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

/**
 * @description log4js silently turns logging OFF on an unknown level, so a
 * typo would hide even errors.
 */
export function logLevel(value: string | undefined, defaultValue: string): string {
  const normalized = value?.trim().toLowerCase();

  return normalized && LOG_LEVELS.includes(normalized) ? normalized : defaultValue;
}
