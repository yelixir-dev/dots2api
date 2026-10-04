export type ImageSize = "auto" | "1024x1024" | "1536x1024" | "1024x1536";
export type ImageQuality = "auto" | "low" | "medium" | "high";

const SHAPE: Readonly<Record<Exclude<ImageSize, "auto">, string>> = {
  "1024x1024": "square (1:1)",
  "1536x1024": "landscape (3:2)",
  "1024x1536": "portrait (2:3)",
};
const DETAIL: Readonly<Record<Exclude<ImageQuality, "auto">, string>> = {
  low: "A quick, simple rendering is fine.",
  medium: "Normal level of detail.",
  high: "Maximum detail, fidelity and realism.",
};

/** A Dot chooses its own output size and quality; these hints ask for them in plain words and are advisory. */
export function buildImagePrompt(input: { readonly prompt: string; readonly size: ImageSize; readonly quality: ImageQuality }): string {
  return [
    "Generate one image and deliver it to me as an image attachment.",
    `Image description: ${input.prompt}`,
    input.size === "auto" ? null : `Shape: ${SHAPE[input.size]}.`,
    input.quality === "auto" ? null : DETAIL[input.quality],
  ].filter((line): line is string => line !== null).join("\n");
}
