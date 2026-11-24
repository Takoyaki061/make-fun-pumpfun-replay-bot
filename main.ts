// Breakout scalper for the pump.fun replay (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the
// SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// Tuned from the first local grade: the base parameter set scored dev net
// -0.126 SOL over 203 round trips (win rate 18.7%, max drawdown 1.6%), with the
// top 3 coins making 34% of the gains — the bot held losers too long and entered
// bursts too late. The tight set below roughly quarters that dev loss on the
// full-window sweep (-0.030 SOL): exits come faster (take-profit 15%, stop 6%,
// 120-slot cap) and entries only take the freshest bursts (age at most 10 slots
// after the CreateEvent, at least 6 distinct non-creator buyers).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const TUNED = {
  ...DEFAULT_PARAMS,
  takeProfit: 0.15,
  stopLoss: 0.06,
  maxHold: 120,
  maxAge: 10,
  minBuyers: 6,
};

await runBot(createStrategy(TUNED));
