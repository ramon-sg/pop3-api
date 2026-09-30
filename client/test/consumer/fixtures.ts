import { test as base } from "@playwright/test";
import { createMailbox, type Mail } from "pop3-api-client";
import { mailboxFixture } from "pop3-api-client/playwright";

const mail: Mail = {
  uidl: "1",
  to: [{ name: "", address: "tests+x@gmail.com" }],
  subject: "Tu código",
  text: "Código 482913 https://shop.cl/verify?t=1",
  attachments: [],
};

// No network: the fixture gets a fake pop3-api through `fetch`.
const fakeFetch = (async () =>
  new Response(JSON.stringify({ success: true, data: [mail] }))) as typeof fetch;

export const test = base.extend(
  mailboxFixture(() => ({
    url: "http://pop3-api.test",
    username: "tests@gmail.com",
    password: "pw",
    fetch: fakeFetch,
  }))
);

// The main entry point works on its own too.
export const standalone = createMailbox({
  url: "http://pop3-api.test",
  username: "tests@gmail.com",
  password: "pw",
  fetch: fakeFetch,
});

export { expect } from "@playwright/test";
