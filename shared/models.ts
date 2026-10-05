/**
 * The System One decision models Opper serves (GET https://api.opper.ai/v3/models?type=evaluation, 2026-10).
 * Shared by the game and the server, which only forwards models from this list.
 */
export const DECISION_MODELS = [
  { id: 'typesafe/jev-1.13.0', name: 'jev 1.13', maker: 'TypeSafe' },
  { id: 'opper/clef', name: 'Clef', maker: 'Cloudflare' },
  { id: 'opper/clef-flash', name: 'Clef Flash', maker: 'Cloudflare' },
  { id: 'opper/kev-4b', name: 'Kev 4B', maker: 'Jared Palmer' },
  { id: 'berget/convaiinnovations/laya', name: 'Laya', maker: 'ConvAI Innovations' },
] as const;

export type ModelId = (typeof DECISION_MODELS)[number]['id'];

export const DEFAULT_MODEL: ModelId = 'typesafe/jev-1.13.0';

export const isModelId = (v: unknown): v is ModelId => DECISION_MODELS.some((m) => m.id === v);

export const modelName = (id: ModelId): string => DECISION_MODELS.find((m) => m.id === id)!.name;
