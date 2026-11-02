import { ModuleRegistry } from "ag-grid-community";
import { IntegratedChartsModule } from "ag-grid-enterprise";
import { AgChartsEnterpriseModule } from "ag-charts-enterprise";
import { isFilm } from "../auth";
import { DecisionTrace } from "./DecisionTrace";
import { LedgerTotals } from "./LedgerTotals";
import { chartTheme, lightTheme, darkTheme } from "./grid-theme";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  type ColDef,
  type GridState,
  type GridApi,
  type ICellRendererParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { Download, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  agentName,
  amountOf,
  money,
  STATUS_LABEL,
  statusTone,
  why,
  type LedgerEntry,
  type State,
  personName,
} from "../api";
import { DecisionCard } from "./Verdict";

// Load the integrated chart bundle with this lazy-loaded screen.
ModuleRegistry.registerModules([IntegratedChartsModule.with(AgChartsEnterpriseModule)]);

function Detail({ entry, close }: { entry: LedgerEntry; close: () => void }) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent className="w-full gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b p-6">
          <SheetTitle>Request #{entry.id}</SheetTitle>
          <SheetDescription>
            {new Date(entry.created_at).toLocaleString("en-US")} · policy{" "}
            {entry.policy_id == null ? "not recorded" : `v${entry.policy_id}`}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 p-4 sm:p-6">
            <DecisionCard entry={entry} />
            <p className="text-xs text-muted-foreground">Source: {entry.source?.toUpperCase() ?? "Inbox"}</p>
            {entry.decline_reason && <p className="rounded-lg border p-3 text-sm">Decline reason: {entry.decline_reason}</p>}
            <details className="rounded-lg border p-4 text-muted-foreground">
              <summary className="text-xs">PayPal response · JSON</summary>
              <pre>
                {entry.source === "history"
                  ? "Simulated · not sent to PayPal"
                  : entry.paypal_result
                    ? JSON.stringify(entry.paypal_result, null, 2)
                    : (entry.error ??
                      "No PayPal response recorded for this request.")}
              </pre>
            </details>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
function LedgerView({
  state,
  selectedId,
}: {
  state: State;
  selectedId?: number;
}) {
  const { resolvedTheme } = useTheme();
  const theme = useMemo(() => (resolvedTheme === "dark" ? darkTheme : lightTheme).withParams({
    selectedRowBackgroundColor: "var(--accent)", rangeSelectionBackgroundColor: "var(--accent)",
    rangeSelectionBorderColor: "var(--ring)", inputBackgroundColor: "var(--background)",
    inputTextColor: "var(--foreground)", inputBorder: { color: "var(--input)", width: 1 },
    menuBackgroundColor: "var(--popover)", menuTextColor: "var(--popover-foreground)",
    panelBackgroundColor: "var(--card)", subtleTextColor: "var(--muted-foreground)",
    chromeBackgroundColor: "var(--card)", oddRowBackgroundColor: "var(--card)",
  }), [resolvedTheme]);
  const grid = useRef<AgGridReact<LedgerEntry>>(null);
  const [groupBy, setGroupBy] = useState("");
  const [selected, setSelected] = useState<number | undefined>(selectedId);
  useEffect(() => setSelected(selectedId), [selectedId]);
  const entry = state.ledger.find((e) => e.id === selected);
  const storageKey = `floorwalker:ledger-views:c2:${state.workspace?.id ?? "film"}:${state.me?.userId ?? "demo"}`;
  const [savedViews] = useState<Record<string, GridState>>(() => {
    try { const value = JSON.parse(localStorage.getItem(storageKey) ?? "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; }
  });
  const [search, setSearch] = useState(savedViews.All?.quickFilter?.text ?? "");
  const [view, setView] = useState("All");
  const activeView = useRef("All");
  // AG Grid 36.2: https://www.ag-grid.com/react-data-grid/grid-state/
  function remember(api: GridApi<LedgerEntry>) {
    const { rowSelection: _selection, focusedCell: _focus, scroll: _scroll, ...snapshot } = api.getState();
    // Our search input uses quickFilterText rather than the grid toolbar.
    savedViews[activeView.current] = { ...snapshot, quickFilter: { text: api.getGridOption("quickFilterText") ?? "" } };
    try { localStorage.setItem(storageKey, JSON.stringify(savedViews)); } catch { /* Private mode still keeps views for this session. */ }
  }
  function chooseView(name: string) {
    const api = grid.current?.api;
    if (!api) return;
    remember(api); activeView.current = name; setView(name); setSearch(savedViews[name]?.quickFilter?.text ?? "");
    if (savedViews[name]) api.setState(savedViews[name]);
    else {
      api.setFilterModel(name === "All" ? null : { status: { filterType: "set", values: name === "Waiting" ? ["awaiting_approval"] : name === "Stopped" ? ["blocked", "declined", "failed"] : ["executed"] } });
    }
  }
  const columns = useMemo<ColDef<LedgerEntry>[]>(
    () => [
      { field: "id", headerName: "#", width: 80, minWidth: 80, cellRenderer: "agGroupCellRenderer", chartDataType: "excluded" },
      {
        field: "created_at",
        headerName: "Time",
        width: 170,
        filter: "agDateColumnFilter",
        cellDataType: "date",
        filterParams: {
          comparator: (filterDate: Date, value: Date) => {
            const day = new Date(value.getFullYear(), value.getMonth(), value.getDate());
            return day.getTime() - filterDate.getTime();
          },
        },
        valueGetter: (p) => p.data ? new Date(p.data.created_at) : null,
        valueFormatter: (p) =>
          p.value ? new Date(p.value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "",
      },
      {
        field: "agent_id",
        headerName: "Agent",
        filter: "agSetColumnFilter", enableRowGroup: true, chartDataType: "category",
        width: 170,
        valueGetter: (p) => (p.data ? agentName(state, p.data.agent_id) : ""),
        cellRenderer: (p: ICellRendererParams<LedgerEntry>) => <span className="ledger-agent-cell"><span aria-hidden="true">{String(p.value ?? "?").split(/[ -]/).filter(Boolean).slice(0, 2).map(word => word[0]).join("")}</span><span>{p.value}</span></span>,
      },
      {
        field: "kind",
        headerName: "Kind",
        filter: "agSetColumnFilter", enableRowGroup: true,
        width: 120,
        valueFormatter: (p) => (p.value ? p.value[0].toUpperCase() + p.value.slice(1) : ""),
      },
      {
        field: "amount",
        headerName: "Amount",
        aggFunc: "sum", enableValue: true, chartDataType: "series",
        useValueFormatterForExport: false,
        width: 125,
        valueGetter: (p) => (p.data ? amountOf(p.data) : 0),
        valueFormatter: (p) =>
          p.data
            ? `${money(amountOf(p.data))}${p.data.approved_amount != null && p.data.approved_amount !== p.data.amount ? ` of ${money(p.data.amount)}` : ""}`
            : p.value == null ? "" : money(p.value),
        cellClass: ["currency", "tabular-nums", "font-medium"],
        cellRenderer: (p: ICellRendererParams<LedgerEntry>) => {
          if (p.value == null) return null;
          const [whole, cents] = money(Number(p.value)).split(".");
          return <span className="ledger-amount-cell"><span>{whole}<small>.{cents}</small></span>{p.data?.approved_amount != null && p.data.approved_amount !== p.data.amount && <small>of {money(p.data.amount)}</small>}</span>;
        },
      },
      {
        field: "counterparty",
        headerName: "Who", enableRowGroup: true,
        flex: 1,
        minWidth: 130,
        valueFormatter: (p) => (p.data || p.value != null ? personName(p.value) : ""),
      },
      {
        field: "status",
        headerName: "Outcome",
        filter: "agSetColumnFilter", enableRowGroup: true,
        filterParams: { valueFormatter: (p: { value: LedgerEntry["status"] }) => STATUS_LABEL[p.value] ?? p.value },
        width: 185,
        valueFormatter: (p) => STATUS_LABEL[p.value as LedgerEntry["status"]],
        cellRenderer: (p: ICellRendererParams<LedgerEntry>) =>
          p.data ? (
            <div className="flex h-full flex-col items-start justify-center gap-1">
              <span className={`ledger-outcome tone-${statusTone(p.data.status)}`}><i aria-hidden="true" />{STATUS_LABEL[p.data.status]}</span>
              {p.data.source === "history" && (
                <Badge variant="secondary" className="text-muted-foreground">
                  Demo history
                </Badge>
              )}
            </div>
          ) : (
            // A group row has no entry; its heading is the outcome the rows share.
            <span className="font-medium">{p.valueFormatted ?? STATUS_LABEL[p.value as LedgerEntry["status"]] ?? p.value}</span>
          ),
      },
      {
        headerName: "Why",
        colId: "why", hide: true,
        flex: 1.3,
        minWidth: 120,
        valueGetter: (p) => (p.data ? why(p.data) : ""),
        tooltipValueGetter: (p) => p.value,
      },
      { field: "source", headerName: "Source", hide: true, filter: "agSetColumnFilter", width: 110,
        valueGetter: (p) => p.data ? p.data.source ?? "inbox" : null },
      { colId: "requests", headerName: "Count", hide: true, valueGetter: (p) => p.data ? 1 : null, aggFunc: "sum", width: 85, chartDataType: "excluded" },
      ...Object.entries(STATUS_LABEL).map(([status, label]): ColDef<LedgerEntry> => ({
        colId: `chart_${status}`, headerName: label, hide: true, suppressColumnsToolPanel: true,
        chartDataType: "series", aggFunc: "sum", cellClass: "currency",
        valueGetter: (p) => p.data ? p.data.status === status ? amountOf(p.data) : 0 : null,
        valueFormatter: (p) => p.value == null ? "" : money(p.value),
      })),
      {
        field: "paypal_ref",
        headerName: "PayPal ref", hide: true, chartDataType: "excluded",
        width: 255,
        cellClass: "font-mono text-xs",
        valueGetter: (p) =>
          p.data?.source === "history"
            ? "Simulated · not sent to PayPal"
            : p.data?.paypal_ref,
      },
    ],
    [state.agents],
  );
  return (
    <Card className="ledger-surface min-w-0 gap-0 overflow-hidden py-0 shadow-xs">
      <CardHeader className="ledger-toolbar">
        <div className="mr-auto space-y-2">
          <CardTitle>All money moves</CardTitle>
          <CardDescription>
            {state.ledger.length} requests · a record of every decision
          </CardDescription>
        </div>
        <div className="relative w-full sm:w-60">
          <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            aria-label="Search ledger"
            placeholder="Search activity…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-xs">
          Group by
          <select aria-label="Group ledger by" value={groupBy} className="rounded-md border bg-background p-2"
            onChange={(e) => { setGroupBy(e.target.value); grid.current?.api.setRowGroupColumns(e.target.value ? [e.target.value] : []); }}>
            <option value="">None</option><option value="agent_id">Agent</option><option value="status">Outcome</option>
            <option value="kind">Kind</option><option value="counterparty">Who</option>
          </select>
        </label>
        <Button variant="outline" onClick={() => {
          const api = grid.current?.api;
          if (!api) return;
          const visible = api.isSideBarVisible();
          api.setSideBarVisible(!visible);
          if (!visible) api.openToolPanel("columns");
        }}>Columns &amp; filters</Button>
        <Button variant="outline" onClick={() => {
          const api = grid.current?.api;
          if (!api) return;
          // The category is always Agent, regardless of the previous row grouping.
          api.setRowGroupColumns([]);
          api.createRangeChart({
          chartType: "stackedColumn", aggFunc: "sum",
          cellRange: { columns: ["agent_id", ...Object.keys(STATUS_LABEL).map((status) => `chart_${status}`)] },
          chartThemeName: resolvedTheme === "dark" ? "floorwalker-dark" : "floorwalker-light",
          chartThemeOverrides: { common: { title: { enabled: true, text: "Money moves by agent and outcome" }, animation: { enabled: !isFilm() && !window.matchMedia("(prefers-reduced-motion: reduce)").matches } } },
          });
        }}>Chart</Button>
        <Button variant="outline" onClick={() => grid.current?.api.exportDataAsExcel({ fileName: "floorwalker-ledger.xlsx", sheetName: "Ledger" })}>
          <Download size={15} />Excel
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            grid.current?.api.exportDataAsCsv({
              fileName: "floorwalker-ledger.csv",
              processCellCallback: (p) => {
                const field = p.column.getColId();
                const row = p.node?.data as LedgerEntry | undefined;
                const raw =
                  field === "amount" && row
                    ? `${money(amountOf(row))}${row.approved_amount != null ? ` of ${money(row.amount)}` : ""}`
                    : field === "status" && row
                      ? `${STATUS_LABEL[row.status]}${row.source === "history" ? " · Demo history" : ""}`
                      : p.value;
                const text = String(raw ?? "");
                return /^[\s]*[=+@\-\t\r\n]/.test(text) ? `'${text}` : text;
              },
            })
          }
        >
          <Download size={15} />
          CSV
        </Button>
      </CardHeader>
      <div className="ledger-views" role="group" aria-label="Saved ledger views">
        {["All", "Waiting", "Stopped", "Done by agents"].map(name => <button type="button" key={name} aria-pressed={view === name} onClick={() => chooseView(name)}>{name}</button>)}
        <span>Filters, columns and grouping are saved per view</span>
      </div>
      <div className="h-[max(520px,calc(100dvh-230px))] min-w-0 w-full">
        <AgGridReact<LedgerEntry>
          ref={grid}
          initialState={savedViews.All}
          onStateUpdated={e => remember(e.api)}
          onGridPreDestroyed={e => remember(e.api)}
          theme={theme}
          columnDefs={columns}
          rowData={state.ledger}
          animateRows={!isFilm() && !window.matchMedia("(prefers-reduced-motion: reduce)").matches}
          masterDetail
          detailRowAutoHeight
          detailCellRenderer={({ data }: ICellRendererParams<LedgerEntry>) => data ? <DecisionTrace entry={data} /> : null}
          groupDefaultExpanded={0}
          autoGroupColumnDef={{ minWidth: 240, cellRendererParams: { suppressCount: false } }}
          onColumnRowGroupChanged={(e) => setGroupBy(e.api.getRowGroupColumns()[0]?.getColId() ?? "")}
          rowSelection={{ mode: "multiRow", enableClickSelection: false, selectAll: "filtered" }}
          cellSelection
          enableCharts
          chartThemes={[resolvedTheme === "dark" ? "floorwalker-dark" : "floorwalker-light"]}
          customChartThemes={{ [resolvedTheme === "dark" ? "floorwalker-dark" : "floorwalker-light"]: chartTheme(resolvedTheme === "dark") }}
          sideBar={{ toolPanels: ["columns", "filters"], hiddenByDefault: true }}
          statusBar={{ statusPanels: [
            { statusPanel: LedgerTotals, align: "left" },
            { statusPanel: "agAggregationComponent", statusPanelParams: { aggFuncs: ["sum", "count"] } },
          ] }}
          excelStyles={[{ id: "currency", dataType: "Number", numberFormat: { format: '$#,##0.00' } }]}
          defaultColDef={{ sortable: true, resizable: true, cellDataType: false }}
          quickFilterText={search}
          getRowId={(p) => String(p.data.id)}
          rowHeight={64}
          headerHeight={48}
          onRowClicked={(e) => {
            if (e.data && !e.node.group && !(e.event?.target as HTMLElement)?.closest(".ag-group-expanded, .ag-group-contracted, .ag-selection-checkbox, .ag-checkbox")) {
              setSelected(e.data.id);
              location.hash = `ledger/${e.data.id}`;
            }
          }}
          onCellKeyDown={(e) => {
            if ((e.event as KeyboardEvent)?.key === "Enter" && e.data && "column" in e && e.column?.getColId() !== "id" && e.column?.getColId() !== "ag-Grid-AutoColumn") {
              setSelected(e.data.id);
              location.hash = `ledger/${e.data.id}`;
            }
          }}
          overlayNoRowsTemplate="No money moves yet. Let an agent handle an inbox item."
          tooltipShowDelay={250}
        />
      </div>
      <div className="flex flex-wrap justify-between gap-2 border-t px-5 py-3 text-xs text-muted-foreground">
        <span>Every action checked before it reaches PayPal.</span>
        <span>Powered by AG Grid</span>
      </div>
      {entry && (
        <Detail
          key={entry.id}
          entry={entry}
          close={() => {
            setSelected(undefined);
            location.hash = "ledger";
          }}
        />
      )}
    </Card>
  );
}

export function Ledger(props: { state: State; selectedId?: number }) {
  return <LedgerView key={`${props.state.workspace?.id ?? "film"}:${props.state.me?.userId ?? "demo"}`} {...props} />;
}
