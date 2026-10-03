// One real batched jev call built from a real game state. Run: npm run smoke
import { buildRequest, parseAnswer, type DecideResponse } from '../src/brain';
import { optionFeatures } from '../src/features';
import { createGame, nextDecisionPoint } from '../src/sim';
import { ACTOR_IDS } from '../src/types';
import { handleDecide } from '../server/decide';

const state = createGame();
state.mode = 'chase';
Object.assign(state.ghosts.pinky, { state: 'normal', tile: { x: 6, y: 5 }, dir: 'right' });
Object.assign(state.ghosts.inky, { state: 'normal', tile: { x: 21, y: 20 }, dir: 'up' });
Object.assign(state.ghosts.clyde, { state: 'normal', tile: { x: 1, y: 29 }, dir: 'right' });

const batch = ACTOR_IDS.flatMap((id) => {
  const point = nextDecisionPoint(state, id);
  return point ? [{ point, features: optionFeatures(state, point) }] : [];
});

if (batch.length !== 5) {
  console.error(`smoke failed: expected 5 decision points, got ${batch.length}`);
  process.exit(1);
}

const result = await handleDecide(buildRequest(state, batch), {
  apiKey: process.env.OPPER_API_KEY,
  baseUrl: process.env.OPPER_BASE_URL || 'https://api.opper.ai',
  fetch,
  now: () => performance.now(),
  timeoutMs: 5000,
  log: console.log,
});
if (result.status !== 200) {
  console.error('smoke failed:', result.body);
  process.exit(1);
}
const res = result.body as DecideResponse;
let failed = false;
for (const q of batch) {
  const d = parseAnswer(res.answers[q.point.actor], q);
  if (!d) {
    failed = true;
    console.error(`${q.point.actor}: invalid answer`, res.answers[q.point.actor]);
    continue;
  }
  console.log(`${q.point.actor.padEnd(7)} at (${d.tile.x},${d.tile.y}) → ${d.choice.padEnd(5)} confidence ${d.confidence} probabilities ${JSON.stringify(d.probabilities)}`);
}
console.log(`questions ${batch.length}, tokens in ${res.usage.input_tokens} out ${res.usage.output_tokens}, latency ${res.latencyMs} ms, cost ${res.costUsd} USD, trace ${res.traceId}`);
process.exit(failed ? 1 : 0);
