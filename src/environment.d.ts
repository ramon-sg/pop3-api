export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      PORT?: string;
      LOG_LEVEL?: string;
      MAIL_HOST?: string;
      MAIL_PORT?: string;
      MAIL_TLS?: string;
      MAIL_REJECT_UNAUTHORIZED?: string;
      MAIL_TIMEOUT_MS?: string;
      MAIL_RETENTION_MS?: string;
      MAIL_RETENTION_MAX?: string;
    }
  }
}
