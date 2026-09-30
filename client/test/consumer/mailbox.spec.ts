import { expect, standalone, test } from "./fixtures.js";

test("the fixture delivers a working mailbox", async ({ mailbox }) => {
  const mail = await mailbox.waitFor({ to: "tests+x@gmail.com", subject: /código/i });

  expect(mailbox.code(mail)).toBe("482913");
  expect(mailbox.links(mail)).toEqual(["https://shop.cl/verify?t=1"]);
  expect(mailbox.alias()).toMatch(/^tests\+/);
});

test("the main entry point works on its own", async () => {
  expect((await standalone.waitFor({ subject: /código/i })).uidl).toBe("1");
});
