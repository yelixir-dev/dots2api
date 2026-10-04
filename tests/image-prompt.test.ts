import { describe, expect, test } from "bun:test";
import { buildImagePrompt } from "../src/image-prompt";

describe("image prompt", () => {
  test("keeps the description verbatim and adds nothing for auto settings", () => {
    const text = buildImagePrompt({ prompt: "a car on a beach\nwith \"quotes\"", size: "auto", quality: "auto" });
    expect(text).toContain('Image description: a car on a beach\nwith "quotes"');
    expect(text).not.toContain("Shape");
    expect(text.split("\n")).toHaveLength(3);
  });

  test.each([["1024x1024", "square (1:1)"], ["1536x1024", "landscape (3:2)"], ["1024x1536", "portrait (2:3)"]] as const)("maps %s to words", (size, words) => {
    expect(buildImagePrompt({ prompt: "p", size, quality: "auto" })).toContain(words);
  });

  test.each([["low", "simple rendering"], ["medium", "Normal level"], ["high", "Maximum detail"]] as const)("maps %s quality to words", (quality, words) => {
    expect(buildImagePrompt({ prompt: "p", size: "auto", quality })).toContain(words);
  });
});
