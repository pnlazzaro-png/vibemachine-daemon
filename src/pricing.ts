// What a call would cost at the API's list prices, in dollars per million
// tokens. On a claude.ai plan this is usage
// measured in money, not money spent. Checked against Claude Code's own
// `costUSD` on the daemon's sessions: the figures match to the cent.
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** Longest matching prefix wins, so a dated id (`claude-opus-4-5-20251101`) finds its family. */
const PRICES: [string, Price][] = [
  ["claude-fable-5-2", { input: 8, output: 40, cacheRead: 0.2, cacheWrite5m: 10, cacheWrite1h: 16 }],
  ["claude-fable-5-1", { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 }],
  ["claude-mythos-5-1", { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 }],
  ["claude-fable-5", { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 }],
  ["claude-mythos-5", { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 }],
  ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 }],
  ["claude-opus-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 }],
  ["claude-opus-4", { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 }],
  ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 }],
  ["claude-sonnet-4", { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 }],
  ["claude-3-7-sonnet", { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 }],
  ["claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 }],
  ["claude-3-5-haiku", { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite5m: 1, cacheWrite1h: 1.6 }],
];

export function priceFor(model: string): Price | null {
  let best: [string, Price] | null = null;
  for (const entry of PRICES) {
    if (model.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best?.[1] ?? null;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** Dollars, or null for a model without a price. */
export function costOf(model: string, t: TokenCounts): number | null {
  const p = priceFor(model);
  if (!p) return null;
  return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite5m * p.cacheWrite5m + t.cacheWrite1h * p.cacheWrite1h) / 1_000_000;
}

/** The short name: opus-5-5, fable-5-1, sonnet-5, haiku-4-5. */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
