import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo, useRef, useState } from "react";
import { DECISION_LABEL, money, STATUS_LABEL, type LedgerEntry, type State } from "../api";
import { Checks, ReviewNote } from "./Verdict";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 13,
  headerFontWeight: 600,
  foregroundColor: "#12233f",
  headerBackgroundColor: "#f5f7fa",
  borderColor: "#e3e7ee",
  rowHoverColor: "#f3f6fb",
  selectedRowBackgroundColor: "#eaf1ff",
  wrapperBorderRadius: 12,
  spacing: 7,
});

const Pill = (p: ICellRendererParams<LedgerEntry>) => <span className={`pill ${p.data?.status}`}>{STATUS_LABEL[p.data!.status]}</span>;
const DecisionPill = (p: ICellRendererParams<LedgerEntry>) => <span className={`pill ${p.data?.decision}`}>{DECISION_LABEL[p.data!.decision]}</span>;

function why(l: LedgerEntry): string {
  const hit = l.checks.find((c) => c.outcome === "block") ?? l.checks.find((c) => c.outcome === "hold");
  return hit ? `${hit.label}: ${hit.detail}` : "All checks passed";
}

export function Ledger({ state }: { state: State }) {
  const grid = useRef<AgGridReact<LedgerEntry>>(null);
  const [selected, setSelected] = useState<LedgerEntry | null>(null);
  const [search, setSearch] = useState("");
  const subjects = useMemo(() => Object.fromEntries(state.tickets.map((t) => [t.id, t.subject])), [state.tickets]);

  const columns = useMemo<ColDef<LedgerEntry>[]>(() => [
    { field: "id", headerName: "#", width: 70, sort: "desc" },
    { field: "created_at", headerName: "Time", width: 110, valueFormatter: (p) => new Date(p.value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) },
    { field: "kind", headerName: "Action", width: 105, valueFormatter: (p) => (p.value === "refund" ? "Refund" : p.value === "payout" ? "Payout" : p.value), filter: true },
    { field: "amount", headerName: "Amount", width: 110, type: "rightAligned", valueFormatter: (p) => money(p.value), filter: "agNumberColumnFilter" },
    { field: "counterparty", headerName: "To", flex: 1, minWidth: 190, filter: true },
    { field: "decision", headerName: "Allowance", width: 125, cellRenderer: DecisionPill, filter: true },
    { field: "status", headerName: "Outcome", width: 150, cellRenderer: Pill, filter: true },
    { headerName: "Why", flex: 2, minWidth: 260, valueGetter: (p) => (p.data ? why(p.data) : ""), tooltipValueGetter: (p) => p.value },
    { field: "ticket_id", headerName: "Inbox item", flex: 1, minWidth: 170, valueFormatter: (p) => (p.value === "ATTACK" ? "Hijacked-agent simulation" : subjects[p.value] ?? "") },
    { field: "paypal_ref", headerName: "PayPal ref", width: 180, cellClass: "mono" },
  ], [subjects]);

  const moved = state.ledger.filter((l) => l.status === "executed" || l.status === "approved");

  return (
    <div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-h">
          <h2>Ledger</h2>
          <span className="hint">Every money move the agent proposed, with the rule or review that decided it. {moved.length} executed in PayPal sandbox.</span>
          <span style={{ flex: 1 }} />
          <input placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "7px 10px", font: "inherit" }} />
          <button className="btn" onClick={() => grid.current?.api.exportDataAsCsv({ fileName: "allowance-ledger.csv" })}>Export CSV</button>
        </div>
        <div style={{ height: 420 }}>
          <AgGridReact<LedgerEntry>
            ref={grid}
            theme={theme}
            rowData={state.ledger}
            columnDefs={columns}
            quickFilterText={search}
            getRowId={(p) => String(p.data.id)}
            rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
            onSelectionChanged={(e) => setSelected(e.api.getSelectedRows()[0] ?? null)}
            tooltipShowDelay={300}
            overlayNoRowsTemplate="No money moves yet. Let the agent handle an inbox item."
          />
        </div>
      </div>
      {selected && (
        <div className="ledger-detail">
          <div className="card">
            <div className="card-h"><h3>#{selected.id} checks</h3><span className={`pill ${selected.decision}`}>{DECISION_LABEL[selected.decision]}</span></div>
            <Checks checks={selected.checks} />
            <ReviewNote review={selected.review} />
            {selected.justification && <div className="card-b"><div className="reason"><b>Agent's reason:</b> {selected.justification}</div></div>}
          </div>
          <div className="card">
            <div className="card-h"><h3>PayPal</h3>{selected.paypal_ref && <code>{selected.paypal_ref}</code>}</div>
            <div className="card-b">
              <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto" }}>
                {selected.paypal_result ? JSON.stringify(selected.paypal_result, null, 2) : selected.error ?? "No PayPal call: Allowance stopped this before it reached PayPal."}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
