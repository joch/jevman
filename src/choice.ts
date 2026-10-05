import { DEFAULT_MODEL, isModelId, modelName, type ModelId } from '../shared/models';
import { ACTOR_IDS, GHOST_IDS, type ActorId } from './types';

/** Which decision model plays each character. Values are model ids from modelOptions. */
export type ModelChoice = Record<ActorId, string>;

/** What /api/me says about models: the ones this key can use and the one the server uses when none is named. */
export interface ModelInfo {
  defaultModel?: string;
  models?: string[];
}

const STORAGE_KEY = 'jevman.models';

export function modelOptions(me: ModelInfo): { id: string; label: string }[] {
  const listed = (me.models ?? [DEFAULT_MODEL]).filter(isModelId).map((id) => ({ id, label: modelName(id) }));
  const def = me.defaultModel ?? DEFAULT_MODEL;
  // An operator's JEV_MODEL may name a System One model that isn't on the shared list.
  return listed.some((o) => o.id === def) ? listed : [{ id: def, label: `${def} (server default)` }, ...listed];
}

/** The server default for every character, then any stored picks that this key still offers. */
export function initialChoice(me: ModelInfo, stored: unknown): ModelChoice {
  const offered = new Set(modelOptions(me).map((o) => o.id));
  const def = me.defaultModel ?? DEFAULT_MODEL;
  const saved = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  return Object.fromEntries(ACTOR_IDS.map((id) => [id, typeof saved[id] === 'string' && offered.has(saved[id]) ? saved[id] : def])) as ModelChoice;
}

export const setGhosts = (choice: ModelChoice, model: string): ModelChoice => ({ ...choice, ...Object.fromEntries(GHOST_IDS.map((id) => [id, model])) });

/** The model to name in a request: none for the server default, so JEV_MODEL keeps applying. */
export const requestModel = (choice: ModelChoice, actor: ActorId, defaultModel: string): ModelId | undefined => {
  const model = choice[actor];
  return model === defaultModel || !isModelId(model) ? undefined : model;
};

export const ghostsShareModel = (choice: ModelChoice): boolean => GHOST_IDS.every((id) => choice[id] === choice.blinky);

export function loadStoredChoice(): unknown {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return null;
  }
}

export function saveChoice(choice: ModelChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // private mode or blocked storage: the choice just isn't remembered
  }
}
