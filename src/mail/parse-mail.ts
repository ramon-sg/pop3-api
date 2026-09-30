import postalMime from "postal-mime";

import type { Mail, MailSummary } from "./types";

/**
 * @description Parses a raw message. Never throws: a message that is empty or
 * cannot be parsed is returned with `error` (and its raw headers, when there
 * are any), because by the time it is parsed it has already been downloaded.
 */
export async function parseMail(
  raw: string,
  uidl?: string,
  parse: typeof postalMime.parse = postalMime.parse
): Promise<Mail> {
  if (!raw || !raw.trim()) {
    return errorMail(raw, uidl, "Empty message");
  }

  try {
    const parsedMail = await parse(raw);

    return {
      uidl,
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
      attachments: parsedMail.attachments as Mail["attachments"],
    };
  } catch (err) {
    return errorMail(raw, uidl, `Unparseable message: ${(err as Error).message}`);
  }
}

export function errorMail(
  raw: string | undefined,
  uidl: string | undefined,
  error: string
): Mail {
  const headers = raw ? rawHeaders(raw) : undefined;

  return {
    uidl,
    error,
    headers,
    messageId: headers?.match(/^message-id:\s*(.+)$/im)?.[1]?.trim(),
    subject: headers?.match(/^subject:\s*(.+)$/im)?.[1]?.trim(),
    attachments: [],
  };
}

export function summarize(mail: Mail): MailSummary {
  return {
    uidl: mail.uidl,
    messageId: mail.messageId,
    to: mail.to,
    subject: mail.subject,
    date: mail.date,
    error: mail.error,
  };
}

function rawHeaders(raw: string): string | undefined {
  const end = raw.search(/\r?\n\r?\n/);
  const headers = end === -1 ? raw : raw.slice(0, end);

  return headers.trim() || undefined;
}
