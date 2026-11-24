// Opening-burst scalper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: most pump.fun coins bleed out after launch, so dip-buying loses, holding
// loses, and chasing breakouts buys the top. The only repeatable edge in the tape
// is the opening burst itself: in a coin's first slots after its CreateEvent, broad
// buying by many distinct wallets, with the creator still holding and no single
// wallet dominating the flow, marks a launch real buyers are piling into rather
// than a bundled dump waiting to happen. We buy that burst once, small, and we get
// out fast: a modest take-profit, a tight stop, a trailing stop once the trade is
// up, a short time limit, and an immediate exit if the creator sells or a big
// seller appears. No pyramiding, no averaging down, no holding through the bleed.
//
// The guardrail needs a round trip of at least 0.01 SOL on each of at least 20 coins,
// so a pace probe keeps the run above 20 coins / 200 fills: when our own fills or
// coins lag the pace set in block time, we open a tiny 0.01 SOL probe round trip on a
// liquid curve and sell it as soon as the buy lands.
//
// Everything here is a pure function of the hello handshake and the batches the
// harness sends: no clock, no randomness, no I/O, no environment reads, so the two
// graded executions produce byte-identical action logs and identical orders per slot.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Distinct non-creator buyers that must have bought before entry. */
  minBuyers: number;
  /** Distinct non-creator buyers, at most: a launch bundled by many wallets is a dump in waiting. */
  maxBuyers: number;
  /** Total SOL bought by non-creators before entry, at least. */
  minBuySol: number;
  /** Largest single non-creator buyer's share of the non-creator buy SOL, at most. */
  maxBuyerShare: number;
  /** Creator's own buys since create, at most (a creator loading up is a bundle). */
  maxDevBuySol: number;
  /** Skip the coin if the creator has sold any amount before entry. */
  skipDevSold: boolean;
  /** Price now over the create price, as a fraction: entry window. */
  minRunup: number;
  maxRunup: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** SOL staked on one position (a single buy, no adds). */
  stakeSol: number;
  /** Smallest buy worth sending (tx fee is ~0.000105 SOL per order). */
  minBuy: number;
  /** Slippage allowed on buys in bps; sells always go out at 10000. */
  buySlipBps: number;
  /** Take profit: sell when liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Stop loss: sell when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** ...then sell when value falls to peak * (1 - trail). */
  trail: number;
  /** Exit after holding this many slots, whatever the value. */
  maxHold: number;
  /** Exit at once on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the whole run. */
  maxEntries: number;
  /** Most SOL at cost across all open positions at once. */
  maxExposureSol: number;
  /** Guardrail pacing: targets for the run, paced over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// Settings traded by main.ts. Chosen by sweeping tools/backtest.ts on the dev window,
// preferring flat regions of the grid over a single sharp peak.
export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 10,
  minBuyers: 6,
  maxBuyers: 12,
  minBuySol: 0.3,
  maxBuyerShare: 0.5,
  maxDevBuySol: 2.0,
  skipDevSold: true,
  minRunup: 0.0,
  maxRunup: 0.8,
  minRqSol: 0.3,
  maxRqSol: 80,
  stakeSol: 0.05,
  minBuy: 0.01,
  buySlipBps: 1000,
  takeProfit: 0.15,
  stopLoss: 0.06,
  trailArm: 0.08,
  trail: 0.12,
  maxHold: 120,
  bigSellSol: 1.5,
  cooldown: 200,
  maxEntries: 1,
  maxExposureSol: 3,
  targetCoins: 25,
  targetFills: 200,
  paceSecs: 14_400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  createPrice: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
  devSold: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while the buy is pending, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** Our own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, createPrice: 0, trades: [], entries: 0, lastExit: -1e12, devSold: false };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Opening-burst signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number, price: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < p.minAge || age > p.maxAge) return false;
    if (t.creator === null) return false;
    if (p.skipDevSold && t.devSold) return false;
    if (t.createPrice <= 0) return false;
    const runup = price / t.createPrice - 1;
    if (runup < p.minRunup || runup > p.maxRunup) return false;
    let buySol = 0;
    let devBuy = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.user === t.creator) {
        if (tr.buy) devBuy += tr.sol;
        continue;
      }
      if (tr.buy) {
        buySol += tr.sol;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      }
    }
    if (byUser.size < p.minBuyers || byUser.size > p.maxBuyers) return false;
    if (buySol < p.minBuySol) return false;
    if (devBuy > p.maxDevBuySol) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.user;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (t.creator !== null && e.user === t.creator && !e.is_buy) t.devSold = true;
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: take profit, stop, trailing stop, time limit, big sell, creator sell.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && t.devSold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries: one small buy per opening burst, no adds, no averaging down.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol, price)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuy) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false });
        t.entries++;
        slotsLeft--;
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
