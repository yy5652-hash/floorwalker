import { useEffect, useState } from "react";
import type { IStatusPanelParams } from "ag-grid-community";
import { moneyTotals, type LedgerEntry } from "../api";

export function LedgerTotals({ api }: IStatusPanelParams<LedgerEntry>) {
  const [totals, setTotals] = useState({ rows: 0, filtered: 0, selected: 0, filteredSum: moneyTotals([]), selectedSum: moneyTotals([]), blockedSum: moneyTotals([]), declinedSum: moneyTotals([]), history: false });
  useEffect(() => {
    const update = () => {
      let rows = 0;
      const filteredRows: LedgerEntry[] = [];
      api.forEachLeafNode(() => rows++);
      api.forEachNodeAfterFilter((node) => {
        if (node.data && !node.group && !node.detail) { filteredRows.push(node.data); }
      });
      const selected = api.getSelectedRows();
      setTotals({ rows, filtered: filteredRows.length, filteredSum: moneyTotals(filteredRows), selected: selected.length, selectedSum: moneyTotals(selected),
        blockedSum: moneyTotals(filteredRows.filter(row => row.status === "blocked")), declinedSum: moneyTotals(filteredRows.filter(row => row.status === "declined")), history: filteredRows.some(row => row.source === "history") });
    };
    update();
    api.addEventListener("modelUpdated", update);
    api.addEventListener("selectionChanged", update);
    return () => {
      if (api.isDestroyed()) return;
      api.removeEventListener("modelUpdated", update);
      api.removeEventListener("selectionChanged", update);
    };
  }, [api]);
  return <div className="flex flex-wrap gap-x-4 gap-y-1 p-3 text-xs" role="status">
    <span>Rows: {totals.rows}</span><span>Filtered: {totals.filtered}</span><span>Selected: {totals.selected}</span>
    <span>Filtered amount: {totals.filteredSum}</span><span>Selected amount: {totals.selectedSum}</span>
    <span>Blocked by Floorwalker: {totals.blockedSum}</span><span>Declined by you: {totals.declinedSum}</span>
    <span className="text-muted-foreground">{totals.history ? "Filtered ledger includes simulated demo history" : "Filtered ledger · live session"}</span>
  </div>;
}
