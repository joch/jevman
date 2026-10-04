import { expect, it } from 'vitest';

// Deliberately failing: proves a red CI run on main cannot deploy. Reverted in the next commit.
it('blocks deployment when CI fails', () => {
  expect('ci').toBe('green');
});
