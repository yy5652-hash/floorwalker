import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { Download, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentName, amountOf, money, STATUS_LABEL, why, type LedgerEntry, type State, personName } from "../api";
import { DecisionCard } from "./Verdict";
import { StatusPill } from "./UI";

// AG Grid 36.2: https://www.ag-grid.com/react-data-grid/theming/
ModuleRegistry.registerModules([AllCommunityModule]);
const theme = themeQuartz.withParams({ fontFamily: "Inter, sans-serif", fontSize: 12, headerFontSize: 11, headerFontWeight: 600, foregroundColor: "#475569", headerBackgroundColor: "#F7F8FA", borderColor: "#E6E8EC", rowHoverColor: "#F1F5FF", accentColor: "#2563EB", wrapperBorderRadius: 0, spacing: 6 });
function Detail({ entry, close }: { entry: LedgerEntry; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return <dialog ref={dialog} className="ledger-drawer" onCancel={close} onClick={e => { if (e.target === e.currentTarget) close(); }} aria-labelledby="ledger-detail-title"><div className="drawer-body"><div className="card-h"><div><span className="eyebrow">Transaction details</span><h2 id="ledger-detail-title">Request #{entry.id}</h2></div><button className="btn icon-btn" aria-label="Close transaction details" onClick={close}><X size={20} /></button></div><div className="drawer-content"><p className="hint">{new Date(entry.created_at).toLocaleString()} · policy {entry.policy_id == null ? "not recorded" : `v${entry.policy_id}`}</p><DecisionCard entry={entry} /><details className="raw-details paypal-json"><summary>PayPal response · JSON</summary><pre>{entry.paypal_result ? JSON.stringify(entry.paypal_result, null, 2) : entry.error ?? "No PayPal response recorded for this request."}</pre></details></div></div></dialog>;
}
export function Ledger({ state, selectedId }: { state: State; selectedId?: number }) {
  const grid = useRef<AgGridReact<LedgerEntry>>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<number | undefined>(selectedId);
  useEffect(() => setSelected(selectedId), [selectedId]);
  const entry = state.ledger.find(e => e.id === selected);
  const columns = useMemo<ColDef<LedgerEntry>[]>(() => [
    { field: "id", headerName: "#", width: 55, minWidth: 45 },
    { field: "created_at", headerName: "Time", width: 85, valueFormatter: p => new Date(p.value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) },
    { field: "agent_id", headerName: "Agent", width: 125, valueGetter: p => p.data ? agentName(state, p.data.agent_id) : "" },
    { field: "kind", headerName: "Action", width: 80, valueFormatter: p => p.value === "refund" ? "Refund" : "Payout" },
    { field: "amount", headerName: "Amount", width: 125, valueGetter: p => p.data ? amountOf(p.data) : 0, valueFormatter: p => p.data ? `${money(amountOf(p.data))}${p.data.approved_amount != null && p.data.approved_amount !== p.data.amount ? ` of ${money(p.data.amount)}` : ""}` : "", cellClass: "money-cell" },
    { field: "counterparty", headerName: "To", flex: 1, minWidth: 130, valueFormatter: p => personName(p.value) },
    { field: "status", headerName: "Outcome", width: 170, valueFormatter: p => STATUS_LABEL[p.value as LedgerEntry["status"]], cellRenderer: (p: ICellRendererParams<LedgerEntry>) => p.data ? <StatusPill status={p.data.status} /> : null },
    { headerName: "Why", colId: "why", flex: 1.3, minWidth: 120, valueGetter: p => p.data ? why(p.data) : "", tooltipValueGetter: p => p.value },
    { field: "paypal_ref", headerName: "PayPal ref", width: 115, cellClass: "mono" },
  ], [state.agents]);
  return <section className="card ledger-card"><div className="ledger-toolbar"><div><h2>All money moves</h2><span className="hint">{state.ledger.length} requests · a record of every decision</span></div><label className="search-input"><Search size={16} /><input aria-label="Search ledger" placeholder="Search activity…" value={search} onChange={e => setSearch(e.target.value)} /></label><button className="btn" onClick={() => grid.current?.api.exportDataAsCsv({ fileName: "allowance-ledger.csv", processCellCallback: p => {
    const field = p.column.getColId();
    const row = p.node?.data as LedgerEntry | undefined;
    const raw = field === "amount" && row ? `${money(amountOf(row))}${row.approved_amount != null ? ` of ${money(row.amount)}` : ""}` : field === "status" && row ? STATUS_LABEL[row.status] : p.value;
    const text = String(raw ?? ""); return /^[\s]*[=+@\-\t\r\n]/.test(text) ? `'${text}` : text;
  } })}><Download size={15} />Export CSV</button></div><div className="ledger-grid"><AgGridReact<LedgerEntry> ref={grid} theme={theme} columnDefs={columns} rowData={state.ledger} defaultColDef={{ sortable: true, resizable: true }} quickFilterText={search} getRowId={p => String(p.data.id)} rowHeight={58} headerHeight={42} onRowClicked={e => { if (e.data) { setSelected(e.data.id); location.hash = `ledger/${e.data.id}`; } }} onCellKeyDown={e => { if ((e.event as KeyboardEvent)?.key === "Enter" && e.data) { setSelected(e.data.id); location.hash = `ledger/${e.data.id}`; } }} overlayNoRowsTemplate="No money moves yet. Let an agent handle an inbox item." tooltipShowDelay={250} /></div><div className="ledger-footer"><span>Every action checked before it reaches PayPal.</span><span>Powered by AG Grid</span></div>{entry && <Detail key={entry.id} entry={entry} close={() => { setSelected(undefined); location.hash = "ledger"; }} />}</section>;
}
