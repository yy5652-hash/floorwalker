import { useEffect, useState } from "react";
import type { IStatusPanelParams } from "ag-grid-community";
import { amountOf, money, type LedgerEntry } from "../api";

export function LedgerTotals({ api }: IStatusPanelParams<LedgerEntry>) {
  const [totals, setTotals] = useState({ rows: 0, filtered: 0, selected: 0, filteredSum: 0, selectedSum: 0 });
  useEffect(() => {
    const update = () => {
      let rows = 0, filtered = 0, filteredSum = 0;
      api.forEachLeafNode(() => rows++);
      api.forEachNodeAfterFilter((node) => {
        if (node.data && !node.group && !node.detail) { filtered++; filteredSum += amountOf(node.data); }
      });
      const selected = api.getSelectedRows();
      setTotals({ rows, filtered, filteredSum, selected: selected.length, selectedSum: selected.reduce((sum, row) => sum + amountOf(row), 0) });
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
    <span>Filtered amount: {money(totals.filteredSum)}</span><span>Selected amount: {money(totals.selectedSum)}</span>
  </div>;
}
