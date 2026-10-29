import { amountOf, type LedgerEntry } from "../api";

const WEEK = 7 * 86400000;
function weekStart(at: number) {
  const date = new Date(at);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.getTime();
}
export function weeklyMoney(ledger: LedgerEntry[], now: number) {
  const start = weekStart(now) - 11 * WEEK;
  const weeks = Array.from({ length: 12 }, (_, i) => ({
    week: new Date(start + i * WEEK).toISOString().slice(0, 10),
    executed: 0, approved: 0, declined: 0, blocked: 0,
  }));
  for (const row of ledger) {
    const at = Date.parse(row.created_at);
    const index = Math.floor((weekStart(at) - start) / WEEK);
    if (at > now || !Number.isFinite(index) || index < 0 || index >= 12) continue;
    if (row.status === "executed" || row.status === "approved" || row.status === "declined" || row.status === "blocked") {
      // Stopped requests are requested amounts; successful moves use the actual approved amount.
      weeks[index][row.status] += row.status === "declined" || row.status === "blocked" ? row.amount : amountOf(row);
    }
  }
  return weeks;
}
