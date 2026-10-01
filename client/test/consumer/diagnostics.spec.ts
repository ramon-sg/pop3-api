import { expect, test, testWithOwnFixtures } from "./fixtures.js";

// Fails on purpose (test.fail): the fixture must attach the diagnostics.
test("a failed waitFor attaches the mailbox diagnostics", async ({ mailbox }) => {
  test.fail();
  await mailbox.waitFor({ to: "tests+x@gmail.com", subject: /nunca/ }, { interval: 5, timeout: 30 });
});

testWithOwnFixtures("own fixtures and the mailbox live together", async ({ mailbox, greeting }) => {
  expect(greeting).toBe("hola");
  expect((await mailbox.waitFor({ subject: /código/i })).uidl).toBe("1");
});

test("a test that never uses the mailbox does not create it", async () => {
  expect(1 + 1).toBe(2);
});
