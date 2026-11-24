# make-fun-pumpfun-replay-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Takoyaki061/make-fun-pumpfun-replay-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Takoyaki061/make-fun-pumpfun-replay-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

An opening-burst scalper for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty. The bot trades 10 SOL of paper money on a replay of pump.fun bonding-curve activity and is scored on net PnL.

## Strategy

Most pump.fun coins bleed out after launch, so dip-buying loses, holding loses, and chasing breakouts buys the top. The only repeatable edge in the tape is the opening burst itself: in a coin's first slots after its CreateEvent, broad buying by many distinct wallets — with the creator still holding and no single wallet dominating the flow — marks a launch real buyers are piling into rather than a bundled dump waiting to happen. The bot buys that burst once, small (0.05 SOL), and gets out fast:

- **Entry:** age 0–10 slots after creation, ≥ 6 distinct non-creator buyers, ≥ 0.3 SOL bought by non-creators, no single buyer over 50% of that flow, creator bought at most 2 SOL and has not sold, price run-up since creation between 0% and 80%, real SOL between 0.3 and 80.
- **Exits:** take-profit +15%, stop-loss −6%, trailing stop (arms at +8%, sells 12% off the peak), 120-slot time limit, immediate exit on a single sell ≥ 1.5 SOL or on any creator sale.
- **Risk:** at most 5 open positions, at most 3 SOL at cost across them, one buy per coin, no pyramiding, no averaging down.
- **Guardrail:** the run needs a round trip of ≥ 0.01 SOL on at least 20 coins, so pace probes open tiny 0.01 SOL probe round trips when fills or coins lag the pace.

Everything is a pure function of the hello handshake and the batches the harness sends — no clock, no randomness, no I/O — so the two graded executions produce byte-identical action logs.

## Results (dev window, kit grade-local)

- Base parameters: net −0.126 SOL over 203 round trips (win rate 18.7%, max drawdown 1.6%).
- Tuned parameters (shipped): full-window local sweep −0.030 SOL over 166 round trips (win rate 19%, max drawdown 0.5%), 106 coins, 332 fills. The dev window is a hard sample — every reference strategy loses on it — so the design optimises for a tiny drawdown and a flat parameter region rather than a sharp dev peak.

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts` on Node 22. The bot speaks `agent-fun/replay/v2` on stdin/stdout via the vendored SDK shim (`vendor/makefun-bot.ts`, a byte-identical copy of the kit's `sdk/ts/makefun-bot.ts`).

## Files

- `main.ts` — entrypoint: runs the strategy with the tuned parameter set.
- `strategy.ts` — the opening-burst scalper (entry/exit rules, probes, pacing).
- `vendor/makefun-bot.ts` — the kit's replay-protocol SDK shim, vendored.

---

<sub>Entered on [make.fun](https://make.fun/?ref=hw8m84ng&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
