import { describe, expect, test } from "bun:test";
import { decodeImage, MAX_IMAGE_BYTES, pngSize, sniffImage } from "../src/images";
import type { ImageMime } from "../src/images";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]).toString("base64");
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ")]).toString("base64");

describe("image decoding", () => {
  test.each<[string, string, ImageMime]>([["png", png, "image/png"], ["jpeg", jpeg, "image/jpeg"], ["webp", webp, "image/webp"]])("identifies %s by its signature", (_name, data, mime) => {
    // Given base64 data, when decoding raw and as a data URL, then both give the signature-derived type.
    expect(decodeImage(data)?.mime).toBe(mime);
    expect(decodeImage(`data:image/x-anything;base64,${data}`)?.mime).toBe(mime);
  });

  test("ignores the declared type: a PNG labelled as text still decodes as PNG", () => {
    expect(decodeImage(`data:text/html;base64,${png}`)?.mime).toBe("image/png");
  });

  test.each([
    ["text", Buffer.from("<script>alert(1)</script>").toString("base64")],
    ["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64")],
    ["empty", ""],
    ["gif", Buffer.from("GIF89a....").toString("base64")],
  ])("rejects %s", (_name, data) => {
    // Given data that is not a supported raster image, then it is not accepted, whatever it claims to be.
    expect(decodeImage(`data:image/png;base64,${data}`)).toBeNull();
    expect(sniffImage(new Uint8Array(Buffer.from(data, "base64")))).toBeNull();
  });

  test("rejects an image above the size limit without decoding it", () => {
    expect(decodeImage("A".repeat(Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 16))).toBeNull();
  });
});

describe("png size", () => {
  test("reads the dimensions from the header", () => {
    expect(pngSize(new Uint8Array(Buffer.from(png, "base64")))).toEqual({ width: 1, height: 1 });
  });

  test("returns null for non-PNG data and truncated headers", () => {
    expect(pngSize(new Uint8Array(Buffer.from(jpeg, "base64")))).toBeNull();
    expect(pngSize(new Uint8Array(Buffer.from(png, "base64")).slice(0, 12))).toBeNull();
  });
});
