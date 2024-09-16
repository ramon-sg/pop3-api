import postalMime from "postal-mime";

import type { Mail } from "./types";

export async function parseMail(str: string): Promise<Mail | null> {
  if (!str) {
    return null;
  }

  const parsedMail = await postalMime.parse(str);

  return {
    subject: parsedMail.subject,
    from: parsedMail.from,
    to: parsedMail.to,
    html: parsedMail.html || undefined,
    text: parsedMail.text,
    sender: parsedMail.sender,
    cc: parsedMail.cc,
    bcc: parsedMail.bcc,
    replyTo: parsedMail.replyTo,
    inReplyTo: parsedMail.inReplyTo,
    messageId: parsedMail.messageId,
    returnPath: parsedMail.returnPath,
    deliveredTo: parsedMail.deliveredTo,
    date: parsedMail.date,
    attachments: parsedMail.attachments,
  };
}
