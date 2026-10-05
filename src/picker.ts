import { ghostsShareModel, setGhosts, type ModelChoice } from './choice';
import { ACTOR_NAMES } from './brain';
import { GHOST_IDS, type ActorId } from './types';

export interface ModelPicking {
  options: { id: string; label: string }[];
  choice: () => ModelChoice;
  onChange: (choice: ModelChoice) => void;
}

export function modelSelect(p: ModelPicking, value: string, onPick: (model: string) => void, label: string): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'model-select';
  select.setAttribute('aria-label', label);
  for (const o of p.options) select.append(new Option(o.label, o.id, false, o.id === value));
  select.addEventListener('change', () => onPick(select.value));
  return select;
}

/**
 * The "which model plays" controls for a mode: Pac-Man's model when the AI plays him, otherwise one model for all
 * ghosts, or one per ghost.
 */
export function renderModelPick(root: HTMLElement, pacmanByModel: boolean, p: ModelPicking): void {
  const choice = p.choice();
  const set = (next: ModelChoice) => {
    p.onChange(next);
    renderModelPick(root, pacmanByModel, p);
  };
  const row = (label: string, control: HTMLElement) => {
    const r = document.createElement('label');
    r.className = 'model-row';
    r.append(Object.assign(document.createElement('span'), { textContent: label }), control);
    return r;
  };
  const rows: HTMLElement[] = [];
  if (pacmanByModel) {
    rows.push(row('Pac-Man is played by', modelSelect(p, choice.pacman, (m) => set({ ...choice, pacman: m }), 'Model playing Pac-Man')));
  } else {
    const perGhost = root.dataset.perGhost === 'true' || !ghostsShareModel(choice);
    if (perGhost) {
      for (const id of GHOST_IDS) rows.push(row(ACTOR_NAMES[id], modelSelect(p, choice[id], (m) => set({ ...choice, [id]: m } as Record<ActorId, string>), `Model playing ${ACTOR_NAMES[id]}`)));
    } else {
      rows.push(row('The ghosts are played by', modelSelect(p, choice.blinky, (m) => set(setGhosts(choice, m)), 'Model playing the ghosts')));
    }
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'link';
    toggle.textContent = perGhost ? 'Same model for all ghosts' : 'Pick a model per ghost';
    toggle.addEventListener('click', () => {
      root.dataset.perGhost = String(!perGhost);
      if (perGhost) set(setGhosts(choice, choice.blinky));
      else renderModelPick(root, pacmanByModel, p);
    });
    rows.push(toggle);
  }
  root.replaceChildren(...rows);
}
