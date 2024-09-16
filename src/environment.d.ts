export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      HOST: string;
      PORT: string;
      TLS: string;
      REJECT_UNAUTHORIZED: string;
      LOG_LEVEL: string;
    }
  }
}
