import { useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams, IStatusPanelParams } from "ag-grid-community";
import { DECISION_LABEL, money, personName, type Simulation, type LedgerEntry } from "../api";
import { Modal } from "./Management";
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
  { field: "at", headerName: "Time", width: 175, valueFormatter: ({ value }) => value ? new Date(value).toLocaleString("en-US") : "" },
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
export function SimulationGrid({ simulation, ledger = [] }: { simulation: Simulation; ledger?: LedgerEntry[] }) {
  const grid = useRef<AgGridReact<Row>>(null);
  const { resolvedTheme } = useTheme();
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [selected, setSelected] = useState<Row | null>(null);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => setSelected(null), [simulation]);
  const original = ledger.find(row => row.id === selected?.id);
  const [grouped, setGrouped] = useState(false);
  const rows = useMemo(() => onlyChanged ? simulation.rows.filter((row) => row.before !== row.after) : simulation.rows, [simulation, onlyChanged]);
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant={onlyChanged ? "secondary" : "outline"} aria-pressed={onlyChanged} onClick={() => setOnlyChanged(!onlyChanged)}>Only changed</Button>
      <Button size="sm" variant={grouped ? "secondary" : "outline"} aria-pressed={grouped} onClick={() => { setGrouped(!grouped); grid.current?.api.setRowGroupColumns(grouped ? [] : ["change"]); }}>Group by change</Button>
    </div>
    <p className="text-xs text-muted-foreground">Select a request to compare decisions and reasons. Keyboard: focus a row and press Enter.</p>
    <div className="simulation-grid h-[440px] w-full min-w-0">
      <AgGridReact<Row> ref={grid} theme={resolvedTheme === "dark" ? darkTheme : lightTheme}
        rowData={rows} columnDefs={columns} defaultColDef={{ sortable: true, resizable: true, filter: true }}
        getRowId={({ data }) => String(data.id)} animateRows={!isFilm() && !reducedMotion} groupDefaultExpanded={0}
        onRowClicked={({ data }) => { if (data) setSelected(data); }}
        onCellKeyDown={({ data, event }) => { if (data && (event as KeyboardEvent)?.key === "Enter") setSelected(data); }}
        autoGroupColumnDef={{ headerName: "Change", minWidth: 190 }}
        rowClassRules={{ "simulation-changed": ({ data }) => !!data && data.before !== data.after }}
        statusBar={{ statusPanels: [{ statusPanel: ChangeCounts, align: "left" }] }}
        overlayNoRowsTemplate={onlyChanged ? "No decisions would change under these rules." : "No past activity to test."} />
    </div>
    <Modal title={selected ? `Request #${selected.id} · ${money(selected.amount)}` : "Request comparison"}
      description={selected ? `${personName(selected.counterparty)} · ${new Date(selected.at).toLocaleString("en-US")}` : "Old and new decisions"}
      open={!!selected} onClose={() => setSelected(null)}>
      {selected && <div className="c1-replay-detail">
        <section><h3>Before · {DECISION_LABEL[selected.before]}</h3>
          {original?.checks.length ? <ul>{original.checks.map((check, i) => <li key={`${check.id}-${i}`}><strong>{check.label} · {check.outcome === "pass" ? "Passed" : DECISION_LABEL[check.outcome]}</strong><p>{check.detail}</p></li>)}</ul> : <p>The original reason was not recorded in the available history.</p>}
        </section>
        <section><h3>After · {DECISION_LABEL[selected.after]}</h3><p>{selected.why || "No new decision reason was returned."}</p>
          <p className="c1-muted">The replay returns one summary reason, not the full set of new checks. Original agent checks and AI review are reused.</p>
        </section>
        <Button variant="outline" onClick={() => setSelected(null)}>Close comparison</Button>
      </div>}
    </Modal>
  </div>;
}
