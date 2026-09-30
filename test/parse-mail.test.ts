import { describe, expect, test } from "bun:test";

import { errorMail, parseMail } from "../src/mail/parse-mail";

describe("parseMail", () => {
  test("parses a message and keeps its uidl", async () => {
    const mail = await parseMail(
      "Subject: Hi\r\nTo: a@b.cl\r\nMessage-ID: <1@b.cl>\r\n\r\nHello",
      "uid-1"
    );

    expect(mail).toMatchObject({
      uidl: "uid-1",
      subject: "Hi",
      messageId: "<1@b.cl>",
      text: "Hello\n",
    });
    expect(mail.error).toBeUndefined();
  });

  test("an empty message is returned with error", async () => {
    expect(await parseMail("", "uid-1")).toMatchObject({
      uidl: "uid-1",
      error: "Empty message",
      attachments: [],
    });
  });
});

describe("errorMail", () => {
  test("keeps the raw headers, subject and message id", () => {
    const mail = errorMail(
      "Subject: Broken\r\nMessage-ID: <x@y.cl>\r\n\r\nbody",
      "uid-9",
      "Unparseable message: boom"
    );

    expect(mail).toEqual({
      uidl: "uid-9",
      error: "Unparseable message: boom",
      headers: "Subject: Broken\r\nMessage-ID: <x@y.cl>",
      messageId: "<x@y.cl>",
      subject: "Broken",
      attachments: [],
    });
  });
});

describe("parseMail with a failing parser", () => {
  test("returns the message with error instead of throwing", async () => {
    const failingParse = async () => {
      throw new Error("boom");
    };

    const mail = await parseMail(
      "Subject: Broken\r\n\r\nbody",
      "uid-2",
      failingParse
    );

    expect(mail).toMatchObject({
      uidl: "uid-2",
      error: "Unparseable message: boom",
      subject: "Broken",
    });
  });
});
