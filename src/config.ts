export const config = {
  logLevel: process.env.LOG_LEVEL || "info",
  port: number(process.env.PORT, 3000),

  mail: {
    host: process.env.MAIL_HOST || "pop.gmail.com",
    port: number(process.env.MAIL_PORT, 995),
    tls: boolean(process.env.MAIL_TLS, true),
    rejectUnauthorized: boolean(process.env.MAIL_REJECT_UNAUTHORIZED, true),
  },
};

function number(
  value: string | undefined,
  defaultValue: any = undefined
): number | undefined {
  if (!value) {
    return defaultValue;
  }

  try {
    return parseInt(value, 10);
  } catch (error) {
    return defaultValue;
  }
}

function boolean(
  value: string | undefined,
  defaultValue: any = undefined
): boolean | undefined {
  if (!value) {
    return defaultValue;
  }

  try {
    JSON.stringify(value);
  } catch (error) {
    return defaultValue;
  }
}
