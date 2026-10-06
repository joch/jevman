import type { Leaderboard } from '../shared/leaderboard';

export interface Versus {
  score: number;
  /** Models whose average score you beat, best first. */
  beaten: string[];
  /** Models still ahead of you, best first. */
  ahead: string[];
  total: number;
}

/** Your classic-game score against each model's leaderboard average (the AIs played the very same game). */
export function versus(board: Leaderboard, score: number): Versus {
  const beaten = board.entries.filter((e) => score > e.meanScore).map((e) => e.name);
  const ahead = board.entries.filter((e) => score <= e.meanScore).map((e) => e.name);
  return { score, beaten, ahead, total: board.entries.length };
}

const list = (names: string[]) => (names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join(' and '));

/** One line for the game-over card. */
export function versusLine(v: Versus): string {
  if (!v.total) return '';
  if (!v.ahead.length) return `You beat every AI on the leaderboard! 🏆`;
  if (!v.beaten.length) return `No AI beaten yet: even ${v.ahead.at(-1)} scores more on average. Try again!`;
  return `You beat ${list(v.beaten)}. ${list(v.ahead)} ${v.ahead.length === 1 ? 'still beats' : 'still beat'} you.`;
}

/** What "Share" posts: short, emoji-marked, with the link. */
export function shareText(v: Versus, url: string): string {
  const head = `I scored ${v.score.toLocaleString('en-US')} at jevman 🟡 and beat ${v.beaten.length} of ${v.total} AIs at Pac-Man`;
  const lines = [head];
  if (v.beaten.length) lines.push(`✅ ${v.beaten.join(' · ')}`);
  if (v.ahead.length) lines.push(`❌ ${v.ahead.join(' · ')}`);
  lines.push(`Can you beat the AI? ${url}`);
  return lines.join('\n');
}
