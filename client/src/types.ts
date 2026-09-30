/**
 * Mirror of the `Mail` returned by pop3-api (`src/mail/types.ts`). Kept in
 * sync by hand: the client has no dependencies on the server.
 */
export type Address = {
  name: string;
  address?: string;
  group?: Address[];
};

export type Attachment = {
  filename: string | null;
  mimeType: string;
  disposition: "attachment" | "inline" | null;
  related?: boolean;
  description?: string;
  contentId?: string;
  method?: string;
  content: unknown;
};

export type Mail = {
  /** Unique id of the message in the POP3 mailbox (pop3-api >= 0.0.3). */
  uidl?: string;
  /** Set when the message could not be read (empty or unparseable). */
  error?: string;
  /** Raw headers, only present when `error` is set. */
  headers?: string;

  from?: Address;
  to?: Address[];
  subject?: string;
  html?: string;
  text?: string;

  sender?: Address;
  cc?: Address[];
  bcc?: Address[];
  replyTo?: Address[];
  inReplyTo?: string;
  messageId?: string;
  returnPath?: string;
  deliveredTo?: string;
  date?: string;
  attachments: Attachment[];
};

export type ApiResponse =
  | { success: true; data: Mail[] }
  | { success: false; error: string };

/**
 * A string matches exactly (addresses ignore case), a RegExp is tested and a
 * function receives the value.
 */
export type Matcher = string | RegExp | ((value: string) => boolean);

/** Every field is optional; the given ones are combined with AND. */
export type MailFilter = {
  /** Matches if any recipient in `to` matches. */
  to?: Matcher;
  from?: Matcher;
  subject?: Matcher;
  text?: Matcher;
  html?: Matcher;
  /** Free filter over the whole mail. */
  where?: (mail: Mail) => boolean;
};

export type WaitOptions = {
  /** Total ms before failing. Checked between polls. Default 60_000. */
  timeout?: number;
  /** Ms between polls. Default 5_000. */
  interval?: number;
};

export type MailboxOptions = {
  /** Where pop3-api runs, e.g. `http://localhost:3033`. */
  url: string;
  username: string;
  password: string;
  /** Defaults for every `waitFor`. */
  wait?: WaitOptions;
  /** Custom fetch, mainly for tests. */
  fetch?: typeof fetch;
};
