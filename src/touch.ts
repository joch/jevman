import type { Dir } from './types';

/** The direction of a swipe from (x0, y0) to (x1, y1), or null for a tap or a swipe shorter than `min` pixels. */
export function swipeDir(x0: number, y0: number, x1: number, y1: number, min = 18): Dir | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < min) return null;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
}

/**
 * Phone controls: swipe anywhere on `surface` (steering as soon as the finger has moved far enough, like a joystick),
 * plus the on-screen pad's buttons (`[data-dir]` inside `pad`).
 */
export function attachTouch(surface: HTMLElement, pad: HTMLElement, steer: (dir: Dir) => void): void {
  let start: { x: number; y: number } | null = null;
  surface.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY };
    },
    { passive: true },
  );
  surface.addEventListener(
    'touchmove',
    (e) => {
      if (!start) return;
      const t = e.touches[0];
      const dir = swipeDir(start.x, start.y, t.clientX, t.clientY);
      if (!dir) return;
      steer(dir);
      start = { x: t.clientX, y: t.clientY }; // a second swipe in the same touch turns again
      e.preventDefault(); // no page scroll while steering
    },
    { passive: false },
  );
  surface.addEventListener('touchend', () => (start = null), { passive: true });
  for (const b of pad.querySelectorAll<HTMLButtonElement>('[data-dir]')) {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      steer(b.dataset.dir as Dir);
    });
  }
}
