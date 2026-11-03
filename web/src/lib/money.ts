type MoneyRow = { currency?: string; amount: number; approved_amount?: number | null; status: string };
export const money = (n: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
/** Historical rows predate currency recording and are all USD. */
export function entryCurrency(row: Pick<MoneyRow, "currency">) {
  return typeof row.currency === "string" ? row.currency : "USD";
}
export function moneyTotals(rows: MoneyRow[], emptyCurrency = "USD") {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const currency = entryCurrency(row);
    totals.set(currency, (totals.get(currency) ?? 0) + (["blocked", "declined"].includes(row.status) ? row.amount : row.approved_amount ?? row.amount));
  }
  return totals.size ? [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => money(value, currency)).join(" · ") : money(0, emptyCurrency);
}

export { formatCheckMoney } from "../../../server/paypal/currency.js";
export function limitsCurrency(row: { currency?: string; checks?: { id: string; detail: string }[] }) {
  return row.checks?.find(check => check.id === "currency")?.detail.match(/your limits are in ([A-Z]{3})/)?.[1] ?? entryCurrency(row);
}
