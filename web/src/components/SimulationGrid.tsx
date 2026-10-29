import { useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams, IStatusPanelParams } from "ag-grid-community";
import { DECISION_LABEL, money, personName, type Simulation } from "../api";
import { isFilm } from "../auth";
import { lightTheme, darkTheme } from "./grid-theme";
import { useTheme } from "./theme-provider";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

type Row = Simulation["rows"][number];
function ChangeCounts({ api }: IStatusPanelParams<Row>) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    const update = () => {
      const next: Record<string, number> = {};
      api.forEachNodeAfterFilter(({ data, group }) => {
        if (data && !group) {
          const change = `${data.before} → ${data.after}`;
          next[change] = (next[change] ?? 0) + 1;
        }
      });
      setCounts(next);
    };
    update();
    api.addEventListener("modelUpdated", update);
    return () => { if (!api.isDestroyed()) api.removeEventListener("modelUpdated", update); };
  }, [api]);
  return <div role="status" className="flex flex-wrap gap-3 p-3 text-xs">
    <span>Filtered: {Object.values(counts).reduce((sum, count) => sum + count, 0)}</span>
    {Object.entries(counts).sort().map(([change, count]) => <span key={change}>{change}: <strong>{count}</strong></span>)}
  </div>;
}
const columns: ColDef<Row>[] = [
  { field: "at", headerName: "Time", width: 175, valueFormatter: ({ value }) => value ? new Date(value).toLocaleString() : "" },
  { field: "tool", headerName: "Kind", width: 100, valueFormatter: ({ value }) => value === "create_refund" ? "Refund" : value === "send_payout" ? "Payout" : value ?? "" },
  { field: "counterparty", headerName: "Who", minWidth: 150, flex: 1, valueFormatter: ({ value }) => personName(value) },
  { field: "amount", headerName: "Amount", width: 120, aggFunc: "sum", valueFormatter: ({ value }) => value == null ? "" : money(value) },
  ...(["before", "after"] as const).map((field): ColDef<Row> => ({
    field, headerName: field === "before" ? "Before" : "After", width: 140,
    valueFormatter: ({ value }) => DECISION_LABEL[value as Row["before"]] ?? "",
    cellRenderer: ({ value }: ICellRendererParams<Row>) => value ? <Badge variant="secondary" className={`tone-${value}`}>{DECISION_LABEL[value as Row["before"]]}</Badge> : null,
  })),
  { field: "why", headerName: "Why", minWidth: 260, flex: 2, wrapText: true, autoHeight: true, tooltipField: "why" },
  { colId: "change", headerName: "Change", hide: true, enableRowGroup: true, valueGetter: ({ data }) => data ? `${data.before} → ${data.after}` : null },
];
export function SimulationGrid({ simulation }: { simulation: Simulation }) {
  const grid = useRef<AgGridReact<Row>>(null);
  const { resolvedTheme } = useTheme();
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [grouped, setGrouped] = useState(false);
  const rows = useMemo(() => onlyChanged ? simulation.rows.filter((row) => row.before !== row.after) : simulation.rows, [simulation, onlyChanged]);
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant={onlyChanged ? "secondary" : "outline"} aria-pressed={onlyChanged} onClick={() => setOnlyChanged(!onlyChanged)}>Only changed</Button>
      <Button size="sm" variant={grouped ? "secondary" : "outline"} aria-pressed={grouped} onClick={() => { setGrouped(!grouped); grid.current?.api.setRowGroupColumns(grouped ? [] : ["change"]); }}>Group by change</Button>
    </div>
    <div className="simulation-grid h-[440px] w-full min-w-0">
      <AgGridReact<Row> ref={grid} theme={resolvedTheme === "dark" ? darkTheme : lightTheme}
        rowData={rows} columnDefs={columns} defaultColDef={{ sortable: true, resizable: true, filter: true }}
        getRowId={({ data }) => String(data.id)} animateRows={!isFilm()} groupDefaultExpanded={0}
        autoGroupColumnDef={{ headerName: "Change", minWidth: 190 }}
        rowClassRules={{ "simulation-changed": ({ data }) => !!data && data.before !== data.after }}
        statusBar={{ statusPanels: [{ statusPanel: ChangeCounts, align: "left" }] }}
        overlayNoRowsTemplate={onlyChanged ? "No decisions would change under these rules." : "No past activity to test."} />
    </div>
  </div>;
}
