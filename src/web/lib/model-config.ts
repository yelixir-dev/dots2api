import type { ModelInfo } from "./api";

export interface OmoModelEntry {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly input: readonly ["text"];
  readonly reasoning: false;
  readonly compat: { readonly supportsStrictMode: false };
}

export interface OmoModelsConfig {
  readonly providers: {
    readonly dots2api: {
      readonly api: "openai-completions";
      readonly baseUrl: string;
      readonly models: readonly OmoModelEntry[];
    };
  };
}

/** Constant fields are bridge facts, not model data. apiKey is omitted on purpose: OmO stores it via `/login dots2api`. */
export function omoModelsConfig(baseUrl: string, models: readonly ModelInfo[]): OmoModelsConfig {
  return {
    providers: {
      dots2api: {
        api: "openai-completions",
        baseUrl,
        models: models.map((model) => ({
          id: model.id,
          name: model.id,
          contextWindow: model.context_window,
          input: ["text"],
          reasoning: false,
          compat: { supportsStrictMode: false },
        })),
      },
    },
  };
}
