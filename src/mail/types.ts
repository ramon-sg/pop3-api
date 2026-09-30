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
  content: ArrayBuffer;
};

export type Mail = {
  /** Unique id of the message in the POP3 mailbox (`UIDL`). */
  uidl?: string;
  /**
   * Set when the message was downloaded but could not be read (empty or
   * unparseable). The message is still returned so it is never lost silently.
   */
  error?: string;
  /** Raw headers of the message, only present when `error` is set. */
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

export type MailSummary = Pick<
  Mail,
  "uidl" | "messageId" | "to" | "subject" | "date" | "error"
>;
