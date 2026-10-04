import { expect, test } from "bun:test";
import { parseThreadId } from "../src/web/lib/format";

test("parseThreadId accepts a bare ID or a chatgpt.com Dot address", () => {
  expect(parseThreadId("  abc-123 ")).toBe("abc-123");
  expect(parseThreadId("https://chatgpt.com/dots/abc-123")).toBe("abc-123");
  expect(parseThreadId("https://chatgpt.com/dots/abc-123?x=1")).toBe("abc-123");
});

test("parseThreadId yields an empty ID when no thread is present", () => {
  expect(parseThreadId("   ")).toBe("");
  expect(parseThreadId("https://chatgpt.com/dots/")).toBe("");
});
