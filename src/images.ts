import { GatewayError } from "./contracts";
import type { ReferenceImage } from "./contracts";

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];
export const IMAGE_EXTENSIONS: Readonly<Record<ImageMime, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** Bound both individual files and the total reference payload, and trust signatures rather than MIME claims. */
export function validateReferenceImages(images: readonly ReferenceImage[]): void {
  if (images.length === 0 || images.length > MAX_IMAGES) {
    throw new GatewayError("invalid_image", `Supply between 1 and ${MAX_IMAGES} reference images.`);
  }
  let bytes = 0;
  for (const image of images) {
    bytes += image.data.byteLength;
    if (image.data.byteLength === 0 || bytes > MAX_IMAGE_BYTES) {
      throw new GatewayError("image_too_large", "Reference images must be nonempty and total at most 32 MiB.", 413);
    }
    if (sniffImage(image.data) !== image.mime) {
      throw new GatewayError("invalid_image", "Reference images must contain PNG, JPEG or WebP bytes.");
    }
  }
}

/** Identify a raster image by its signature. A remote claim about the type is never trusted. */
export function sniffImage(bytes: Uint8Array): ImageMime | null {
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

/** Decode raw base64 or a base64 data URL; returns null for anything that is not a supported image. */
export function decodeImage(text: string): { readonly mime: ImageMime; readonly data: Uint8Array } | null {
  const payload = text.startsWith("data:") ? text.slice(text.indexOf(",") + 1) : text;
  if (payload.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4) return null;
  const data = new Uint8Array(Buffer.from(payload, "base64"));
  const mime = sniffImage(data);
  return mime && data.byteLength <= MAX_IMAGE_BYTES ? { mime, data } : null;
}

/** Width and height from a PNG header, or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
  if (sniffImage(bytes) !== "image/png" || bytes.byteLength < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}
