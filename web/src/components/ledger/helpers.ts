import type { LedgerEntry } from "../../api";
import { entryCurrency, money } from "../../lib/money";

export const outcomeLabels: Record<LedgerEntry["status"], string> = {
  executed: "Done automatically",
  approved: "Approved by you",
  awaiting_approval: "Waiting for you",
  executing: "Processing in PayPal",
  declined: "Declined by you",
  blocked: "Blocked by Floorwalker",
  failed: "Payment failed",
};

export function aggregateCurrency(values: unknown[]) {
  const currencies = new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0));
  return currencies.size > 1 || currencies.has("Mixed currencies") ? "Mixed currencies" : [...currencies][0] ?? "";
}

export function formatAggregate(amount: number | null | undefined, currency: string) {
  if (currency === "Mixed currencies") return currency;
  return amount == null || !currency ? "" : `${money(amount, currency)} ${currency}`;
}

export function decisionAttribution(entry: LedgerEntry) {
  if (entry.status === "blocked") return { text: "Blocked by Floorwalker — nothing was sent to PayPal", at: entry.decided_at ?? entry.created_at };
  if (entry.decided_by) return { text: `Decided by ${entry.decided_by}`, at: entry.decided_at ?? entry.created_at };
  if (entry.decision === "allow" && entry.status !== "approved" && entry.status !== "declined") return { text: "Decided automatically by your rules", at: entry.decided_at ?? entry.created_at };
  if (entry.status === "awaiting_approval") return { text: "Waiting for your decision", at: entry.created_at };
  return { text: "Not recorded", at: entry.decided_at };
}

export function largestBlocked(rows: LedgerEntry[]) {
  return rows.filter(row => row.status === "blocked").reduce<LedgerEntry | undefined>((largest, row) =>
    !largest || row.amount > largest.amount ? row : largest, undefined);
}

// Explicit keys include audit fields even when the grid hides them; chart series stay out.
export const exportColumns = ["id", "created_at", "agent_id", "kind", "amount", "currency", "counterparty", "status", "source", "policy_id", "decision", "decided_by", "decided_at", "paypal_ref", "why"];

export function exportCell(row: LedgerEntry, column: string, fallback: unknown): string {
  let value: unknown = fallback;
  if (column === "source") value = row.source === "history" ? "Demo history (simulated)" : `Live session · ${row.source ?? "inbox"}`;
  else if (column === "currency") value = entryCurrency(row);
  else if (column === "amount") value = row.approved_amount ?? row.amount;
  else if (column === "status") value = outcomeLabels[row.status];
  else if (column === "policy_id") value = row.policy_id == null ? "Not recorded" : `v${row.policy_id}`;
  else if (column === "decision") value = row.decision;
  else if (column === "decided_by") value = decisionAttribution(row).text;
  else if (column === "decided_at") value = decisionAttribution(row).at ?? "Not recorded";
  else if (column === "paypal_ref") value = row.source === "history" ? "Simulated · not sent to PayPal" : row.paypal_ref ?? "Not recorded";
  const text = String(value ?? "");
  return /^[\s]*[=+@\-\t\r\n]/.test(text) ? `'${text}` : text;
}
