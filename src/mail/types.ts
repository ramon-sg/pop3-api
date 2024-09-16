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
  messageId: string;
  returnPath?: string;
  deliveredTo?: string;
  date?: string;
  attachments: Attachment[];
};
