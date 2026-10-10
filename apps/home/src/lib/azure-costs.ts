// AZURE SPENDING FOR THE ADMIN TAB (Global.Church, 2026-10-09) — the request bodies and the pure shaping of what
// Cost Management answers. The fetching lives in server/connect/admin.ts; this file never touches the network.
//
// One rule above the others: a figure Azure did not give us is UNAVAILABLE, never $0. An unconfigured or failing
// call shapes to `{ ok: false, reason }`, and the page says so.

/** Cost Management's tabular answer: `properties.columns` + `properties.rows`. */
export interface CostTable {
  properties?: { columns?: { name: string; type?: string }[]; rows?: unknown[][] };
}

const COST_COLUMNS = ['Cost', 'PreTaxCost', 'CostUSD', 'totalCost'];

function col(t: CostTable, names: string[]): number {
  const cols = t.properties?.columns ?? [];
  for (const n of names) {
    const i = cols.findIndex((c) => c.name.toLowerCase() === n.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

function sumCost(t: CostTable): number {
  const ci = col(t, COST_COLUMNS);
  if (ci < 0) return 0;
  return (t.properties?.rows ?? []).reduce((s, r) => s + num(r[ci]), 0);
}

function currencyOf(...tables: CostTable[]): string {
  for (const t of tables) {
    const i = col(t, ['Currency']);
    const v = i >= 0 ? t.properties?.rows?.[0]?.[i] : undefined;
    if (typeof v === 'string' && v) return v;
  }
  return 'USD';
}

/** `20261001` (Cost Management's UsageDate) or an ISO string → `2026-10-01`. */
export function isoDay(v: unknown): string {
  const s = String(v ?? '');
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s.slice(0, 10);
}

/** `AZURE_RG_LABELS="rg-gcchain=Chain,rg-akcs-pilot-cus=Key service (AKCS)"` → a lower-cased lookup. */
export function parseLabels(raw: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of (raw ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) m.set(pair.slice(0, i).trim().toLowerCase(), pair.slice(i + 1).trim());
  }
  return m;
}

const dataset = (grouping?: string) => ({
  granularity: 'None',
  aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
  ...(grouping ? { grouping: [{ type: 'Dimension', name: grouping }] } : {}),
});

/** The four request bodies, as of `now`. */
export function costQueries(now: Date) {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const from30 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29));
  return {
    monthByGroup: { type: 'ActualCost', timeframe: 'MonthToDate', dataset: dataset('ResourceGroupName') },
    lastMonth: { type: 'ActualCost', timeframe: 'TheLastMonth', dataset: dataset() },
    daily: {
      type: 'ActualCost',
      timeframe: 'Custom',
      timePeriod: { from: `${day(from30)}T00:00:00Z`, to: `${day(now)}T23:59:59Z` },
      dataset: { granularity: 'Daily', aggregation: { totalCost: { name: 'Cost', function: 'Sum' } } },
    },
    // The REST of the month only (includeActualCost false), so month-end = month-to-date + this. Null when the
    // month has no days left to forecast.
    forecast:
      tomorrow <= monthEnd
        ? {
            type: 'ActualCost',
            timeframe: 'Custom',
            timePeriod: { from: `${day(tomorrow)}T00:00:00Z`, to: `${day(monthEnd)}T23:59:59Z` },
            dataset: { granularity: 'Daily', aggregation: { totalCost: { name: 'Cost', function: 'Sum' } } },
            includeActualCost: false,
            includeFreshPartialCost: false,
          }
        : null,
    monthStart: day(monthStart),
  };
}

export interface Budget { name: string; amount: number; currentSpend: number | null }

export interface CostsView {
  ok: true;
  currency: string;
  monthStart: string;
  monthToDate: number;
  lastMonth: number | null;
  /** Month-to-date plus Azure's forecast for the rest of the month; null when Azure gave no forecast. */
  forecastMonthEnd: number | null;
  budget: Budget | null;
  byGroup: { group: string; label: string; cost: number }[];
  daily: { day: string; cost: number }[];
  asOf: number;
}
export type CostsResult = CostsView | { ok: false; reason: string; asOf: number };

/** Shape the four answers. `monthByGroup` is required; the others may be null when their call failed — the page
 *  then shows that one figure as unavailable rather than dropping the whole section. */
export function shapeCosts(input: {
  monthByGroup: CostTable;
  lastMonth: CostTable | null;
  daily: CostTable | null;
  forecast: CostTable | null;
  budgets: { value?: { name?: string; properties?: { amount?: number; timeGrain?: string; currentSpend?: { amount?: number } } }[] } | null;
  budgetName?: string;
  labels?: Map<string, string>;
  monthStart: string;
  /** No forecast call was made because the month is over. */
  noDaysLeft?: boolean;
  now: number;
}): CostsView {
  const t = input.monthByGroup;
  const ci = col(t, COST_COLUMNS);
  const gi = col(t, ['ResourceGroupName', 'ResourceGroup']);
  const byGroupMap = new Map<string, number>();
  for (const r of t.properties?.rows ?? []) {
    const g = gi >= 0 ? String(r[gi] ?? '').toLowerCase() || '(no resource group)' : '(all)';
    byGroupMap.set(g, (byGroupMap.get(g) ?? 0) + (ci >= 0 ? num(r[ci]) : 0));
  }
  const byGroup = [...byGroupMap.entries()]
    .map(([group, cost]) => ({ group, label: input.labels?.get(group) ?? group, cost }))
    .sort((a, b) => b.cost - a.cost);
  const monthToDate = byGroup.reduce((s, g) => s + g.cost, 0);

  let daily: { day: string; cost: number }[] = [];
  if (input.daily) {
    const dc = col(input.daily, COST_COLUMNS);
    const di = col(input.daily, ['UsageDate', 'BillingMonth', 'Date']);
    const m = new Map<string, number>();
    for (const r of input.daily.properties?.rows ?? []) {
      if (di < 0 || dc < 0) break;
      const d = isoDay(r[di]);
      m.set(d, (m.get(d) ?? 0) + num(r[dc]));
    }
    daily = [...m.entries()].map(([day, cost]) => ({ day, cost })).sort((a, b) => a.day.localeCompare(b.day));
  }

  const budgets = input.budgets?.value ?? [];
  const b = budgets.find((x) => x.name === input.budgetName) ?? budgets.find((x) => (x.properties?.timeGrain ?? 'Monthly') === 'Monthly');
  const budget: Budget | null =
    b && typeof b.properties?.amount === 'number'
      ? { name: b.name ?? 'budget', amount: b.properties.amount, currentSpend: typeof b.properties.currentSpend?.amount === 'number' ? b.properties.currentSpend.amount : null }
      : null;

  return {
    ok: true,
    currency: currencyOf(t, ...(input.lastMonth ? [input.lastMonth] : [])),
    monthStart: input.monthStart,
    monthToDate,
    lastMonth: input.lastMonth ? sumCost(input.lastMonth) : null,
    forecastMonthEnd: input.noDaysLeft ? monthToDate : input.forecast ? monthToDate + sumCost(input.forecast) : null,
    budget,
    byGroup,
    daily,
    asOf: input.now,
  };
}

/** ok · warn (forecast over budget, or 80% spent) · over (spent past the budget). */
export function budgetTone(v: Pick<CostsView, 'monthToDate' | 'forecastMonthEnd' | 'budget'>): 'ok' | 'warn' | 'danger' | undefined {
  if (!v.budget) return undefined;
  if (v.monthToDate > v.budget.amount) return 'danger';
  if (v.monthToDate >= 0.8 * v.budget.amount || (v.forecastMonthEnd ?? 0) > v.budget.amount) return 'warn';
  return 'ok';
}
