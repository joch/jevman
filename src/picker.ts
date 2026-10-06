import type { ModelChoice } from './choice';

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
