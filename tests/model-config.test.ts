import { expect, test } from "bun:test";
import type { ModelInfo } from "../src/web/lib/api";
import { omoModelsConfig } from "../src/web/lib/model-config";

test("omoModelsConfig derives the OmO dots2api provider entry from /v1/models only", () => {
  const models: ModelInfo[] = [
    { id: "probe-agent", context_window: 123_456, context_basis: "measured-heuristic" },
    { id: "other-agent", context_window: 64_000, context_basis: "configured" },
  ];
  const bridge = { input: ["text"], reasoning: false, compat: { supportsStrictMode: false } } as const;

  expect(omoModelsConfig("http://localhost:4321/v1", models)).toEqual({
    providers: {
      dots2api: {
        api: "openai-completions",
        baseUrl: "http://localhost:4321/v1",
        models: [
          { id: "probe-agent", name: "probe-agent", contextWindow: 123_456, ...bridge },
          { id: "other-agent", name: "other-agent", contextWindow: 64_000, ...bridge },
        ],
      },
    },
  });
});
