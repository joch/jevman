import { DEFAULT_MODEL, type ModelId } from '../shared/models.ts';

/** Where jev calls go: Opper's TypeSafe-compatible endpoint, or TypeSafe's own System One API. */
export type JevProvider = 'opper' | 'typesafe';

export interface JevTarget {
  provider: JevProvider;
  apiKey: string;
  baseUrl: string;
}

export const OPPER_BASE_URL = 'https://api.opper.ai';
export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';

/** TypeSafe bills input tokens only (docs.typesafe.ai/models, 2026-10): $0.042 per million. */
export const TYPESAFE_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

const PATHS: Record<JevProvider, string> = { opper: '/v3/compat/v1/systemone', typesafe: '/v1/systemone' };

/** The model id to send: Opper takes any listed model by its catalog id; TypeSafe's own API only serves jev. */
export function modelFor(provider: 'opper', model?: ModelId): string;
export function modelFor(provider: JevProvider, model?: ModelId): string | null;
export function modelFor(provider: JevProvider, model: ModelId = DEFAULT_MODEL): string | null {
  if (provider === 'opper') return model;
  return model === DEFAULT_MODEL ? 'jev-1.13.0' : null;
}

export const endpointFor = (t: JevTarget): string => `${t.baseUrl.replace(/\/+$/, '')}${PATHS[t.provider]}`;

/** The server's own key from the environment: TYPESAFE_API_KEY (straight to TypeSafe) wins over OPPER_API_KEY. */
export function devTargetFromEnv(env: Record<string, string | undefined>): JevTarget | undefined {
  if (env.TYPESAFE_API_KEY) return { provider: 'typesafe', apiKey: env.TYPESAFE_API_KEY, baseUrl: env.TYPESAFE_BASE_URL || TYPESAFE_BASE_URL };
  if (env.OPPER_API_KEY) return { provider: 'opper', apiKey: env.OPPER_API_KEY, baseUrl: env.OPPER_BASE_URL || OPPER_BASE_URL };
  return undefined;
}
