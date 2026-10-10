import { describe, expect, it } from 'vitest';
import { budgetTone, costQueries, isoDay, parseLabels, shapeCosts } from './azure-costs';

const table = (columns: string[], rows: unknown[][]) => ({ properties: { columns: columns.map((name) => ({ name })), rows } });
const now = Date.UTC(2026, 9, 9, 12);

describe('Azure cost queries', () => {
  it('forecasts only the rest of this month', () => {
    const q = costQueries(new Date(now));
    expect(q.monthStart).toBe('2026-10-01');
    expect(q.forecast?.timePeriod.from).toBe('2026-10-10T00:00:00Z');
    expect(q.forecast?.timePeriod.to).toBe('2026-10-31T23:59:59Z');
    expect(q.daily.timePeriod.from).toBe('2026-09-10T00:00:00Z');
  });
  it('has nothing to forecast on the last day of the month', () => {
    expect(costQueries(new Date(Date.UTC(2026, 9, 31, 12))).forecast).toBeNull();
  });
});

describe('shaping what Azure answers', () => {
  const monthByGroup = table(['Cost', 'ResourceGroupName', 'Currency'], [
    [120.5, 'RG-GCCHAIN', 'USD'],
    [200, 'rg-akcs-pilot-cus', 'USD'],
    [10, 'rg-gcchain', 'USD'],
  ]);
  it('totals by resource group with friendly names, largest first', () => {
    const v = shapeCosts({
      monthByGroup, lastMonth: table(['Cost', 'Currency'], [[480, 'USD']]),
      daily: table(['Cost', 'UsageDate', 'Currency'], [[10, 20261002, 'USD'], [12, 20261001, 'USD']]),
      forecast: table(['Cost', 'UsageDate', 'CostStatus'], [[15, 20261010, 'Forecast'], [15, 20261011, 'Forecast']]),
      budgets: { value: [{ name: 'gc-estate-monthly', properties: { amount: 700, timeGrain: 'Monthly' } }] },
      labels: parseLabels('rg-gcchain=Chain, rg-akcs-pilot-cus=Key service (AKCS)'),
      monthStart: '2026-10-01', now,
    });
    expect(v.monthToDate).toBeCloseTo(330.5);
    expect(v.byGroup.map((g) => g.label)).toEqual(['Key service (AKCS)', 'Chain']);
    expect(v.byGroup[1]!.cost).toBeCloseTo(130.5);
    expect(v.lastMonth).toBe(480);
    expect(v.forecastMonthEnd).toBeCloseTo(360.5);
    expect(v.budget).toEqual({ name: 'gc-estate-monthly', amount: 700, currentSpend: null });
    expect(v.daily).toEqual([{ day: '2026-10-01', cost: 12 }, { day: '2026-10-02', cost: 10 }]);
    expect(budgetTone(v)).toBe('ok');
  });

  it('a call that failed is unavailable (null), never $0', () => {
    const v = shapeCosts({ monthByGroup, lastMonth: null, daily: null, forecast: null, budgets: null, monthStart: '2026-10-01', now });
    expect(v.lastMonth).toBeNull();
    expect(v.forecastMonthEnd).toBeNull();
    expect(v.budget).toBeNull();
    expect(v.daily).toEqual([]);
    expect(budgetTone(v)).toBeUndefined();
  });

  it('warns when the forecast passes the budget, and is over once spending does', () => {
    const budget = { name: 'b', amount: 700, currentSpend: null };
    expect(budgetTone({ monthToDate: 300, forecastMonthEnd: 750, budget })).toBe('warn');
    expect(budgetTone({ monthToDate: 600, forecastMonthEnd: 650, budget })).toBe('warn');
    expect(budgetTone({ monthToDate: 710, forecastMonthEnd: 800, budget })).toBe('danger');
  });

  it('reads Azure day formats', () => {
    expect(isoDay(20261009)).toBe('2026-10-09');
    expect(isoDay('2026-10-09T00:00:00')).toBe('2026-10-09');
  });
});
