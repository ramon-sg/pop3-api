export const config = {
  logLevel: process.env.LOG_LEVEL || "info",
  port: number(process.env.PORT, 3000),

  mail: {
    host: process.env.MAIL_HOST || "pop.gmail.com",
    port: number(process.env.MAIL_PORT, 995),
    tls: boolean(process.env.MAIL_TLS, true),
    rejectUnauthorized: boolean(process.env.MAIL_REJECT_UNAUTHORIZED, true),
    timeoutMs: number(process.env.MAIL_TIMEOUT_MS, 30_000),
  },
};

export function number(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = parseInt(value, 10);

  return Number.isNaN(parsed) ? defaultValue : parsed;
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
