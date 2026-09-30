import { describe, expect, test } from "bun:test";

import { boolean, number } from "../src/config";

describe("boolean", () => {
  test.each([
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["false", false],
    ["0", false],
    ["no", false],
  ])("%p → %p", (value, expected) => {
    expect(boolean(value, !expected)).toBe(expected);
  });

  test("falls back to the default when unset or invalid", () => {
    expect(boolean(undefined, true)).toBe(true);
    expect(boolean("", false)).toBe(false);
    expect(boolean("maybe", true)).toBe(true);
  });
});

describe("number", () => {
  test("parses integers and falls back when invalid", () => {
    expect(number("995", 1)).toBe(995);
    expect(number(undefined, 3000)).toBe(3000);
    expect(number("abc", 3000)).toBe(3000);
  });
});
