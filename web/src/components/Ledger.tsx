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
  type ProcessCellForExportParams,
  type IAggFuncParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { Download, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  agentName,
  amountOf,
  money,
  entryCurrency,
  statusTone,
  why,
  type LedgerEntry,
  type State,
  personName,
} from "../api";
import { aggregateCurrency, decisionAttribution, exportCell, exportColumns, formatAggregate, largestBlocked, outcomeLabels as STATUS_LABEL } from "./ledger/helpers";

// Load the integrated chart bundle with this lazy-loaded screen.
ModuleRegistry.registerModules([IntegratedChartsModule.with(AgChartsEnterpriseModule)]);
const ledgerAggFuncs = { ledgerCurrency: (p: IAggFuncParams) => aggregateCurrency(p.values) };

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
            <div className="space-y-2 rounded-lg border p-4">
              <Badge variant="secondary" className={`tone-${statusTone(entry.status)}`}>{STATUS_LABEL[entry.status]}</Badge>
              <p className="font-medium">{money(amountOf(entry), entryCurrency(entry))} · {personName(entry.counterparty)}</p>
              {entry.justification && <p className="text-sm text-muted-foreground">{entry.justification}</p>}
            </div>
            <p className="text-xs text-muted-foreground">Source: {entry.source === "history" ? "Demo history (simulated)" : `Live session · ${entry.source ?? "inbox"}`}</p>
            <DecisionTrace entry={entry} />
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
  const mixedCurrencies = new Set(state.ledger.map(entryCurrency)).size > 1;
  const ledgerCurrency = entryCurrency(state.ledger[0] ?? { currency: state.policy.policy.currency });
  const storageKey = `floorwalker:ledger-views:c3:${state.workspace?.id ?? "film"}:${state.me?.userId ?? "demo"}`;
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
    remember(api); activeView.current = name; setView(name);
    if (name === "All" || name === "Investigate stopped requests") {
      setSearch(""); api.setGridOption("quickFilterText", "");
      api.deselectAll(); api.collapseAll();
      setSelected(undefined); location.hash = "ledger";
      api.setFilterModel(name === "All" ? null : { status: { filterType: "set", values: ["blocked", "declined"] } });
      api.setRowGroupColumns(name === "All" ? [] : ["agent_id"]);
      api.applyColumnState({ state: name === "All" ? [] : [{ colId: "amount", sort: "desc" }], defaultState: { sort: null } });
      if (name !== "All") {
        const blocked = largestBlocked(state.ledger);
        const node = blocked && api.getRowNode(String(blocked.id));
        if (node) { api.setRowNodeExpanded(node, true, true, true); api.ensureNodeVisible(node, "top"); }
      }
      return;
    }
    setSearch(savedViews[name]?.quickFilter?.text ?? "");
    if (savedViews[name]) api.setState(savedViews[name]);
    else {
      api.setFilterModel({ status: { filterType: "set", values: name === "Waiting" ? ["awaiting_approval"] : ["executed"] } });
    }
  }
  function processExportCell(p: ProcessCellForExportParams) {
    return p.node?.data ? exportCell(p.node.data as LedgerEntry, p.column.getColId(), p.value) : "";
  }
  const columns = useMemo<ColDef<LedgerEntry>[]>(
    () => [
      { field: "id", headerName: "#", width: 100, minWidth: 80, chartDataType: "excluded",
        cellRendererSelector: (p) => !p.api.getRowGroupColumns().length ? { component: "agGroupCellRenderer" } : undefined },
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
        aggFunc: "sum", enableValue: !mixedCurrencies, chartDataType: mixedCurrencies ? "excluded" : "series",
        useValueFormatterForExport: false,
        width: 170,
        minWidth: 155,
        tooltipValueGetter: (p) => p.valueFormatted ?? "",
        valueGetter: (p) => (p.data ? amountOf(p.data) : 0),
        valueFormatter: (p) =>
          p.data
            ? `${money(amountOf(p.data), entryCurrency(p.data))}${p.data.approved_amount != null && p.data.approved_amount !== p.data.amount ? ` of ${money(p.data.amount, entryCurrency(p.data))}` : ""}`
            : formatAggregate(p.value, p.node?.aggData?.currency ?? ""),
        cellClass: ["currency", "tabular-nums", "font-medium"],
        cellRenderer: (p: ICellRendererParams<LedgerEntry>) => {
          if (p.value == null) return null;
          return <span className="ledger-amount-cell"><span>{p.data ? money(Number(p.value), entryCurrency(p.data)) : p.valueFormatted}</span>{p.data?.approved_amount != null && p.data.approved_amount !== p.data.amount && <small>of {money(p.data.amount, entryCurrency(p.data))}</small>}</span>;
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
        valueGetter: (p) => p.data ? exportCell(p.data, "source", null) : null },
      { field: "currency", headerName: "Currency", hide: true, chartDataType: "excluded", aggFunc: "ledgerCurrency",
        valueGetter: (p) => p.data ? entryCurrency(p.data) : null },
      { field: "policy_id", headerName: "Policy version", hide: true, chartDataType: "excluded",
        valueFormatter: (p) => p.value == null ? "Not recorded" : `v${p.value}` },
      { field: "decision", headerName: "Decision", hide: true, chartDataType: "excluded" },
      { field: "decided_by", headerName: "Decided by", hide: true, chartDataType: "excluded",
        valueGetter: (p) => p.data ? decisionAttribution(p.data).text : null },
      { field: "decided_at", headerName: "Decision time", hide: true, chartDataType: "excluded",
        valueGetter: (p) => p.data ? decisionAttribution(p.data).at : null },
      { colId: "requests", headerName: "Count", hide: true, valueGetter: (p) => p.data ? 1 : null, aggFunc: "sum", width: 85, chartDataType: "excluded" },
      ...Object.entries(STATUS_LABEL).map(([status, label]): ColDef<LedgerEntry> => ({
        colId: `chart_${status}`, headerName: label, hide: true, suppressColumnsToolPanel: true,
        chartDataType: mixedCurrencies ? "excluded" : "series", aggFunc: mixedCurrencies ? undefined : "sum", cellClass: "currency",
        valueGetter: (p) => p.data ? p.data.status === status ? amountOf(p.data) : 0 : null,
        valueFormatter: (p) => p.value == null || mixedCurrencies ? "" : money(p.value, p.data ? entryCurrency(p.data) : ledgerCurrency),
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
    [state.agents, mixedCurrencies, ledgerCurrency],
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
        <Button variant="outline" disabled={mixedCurrencies} title={mixedCurrencies ? "Use the per-currency charts on Overview for mixed currencies." : undefined} onClick={() => {
          const api = grid.current?.api;
          if (!api) return;
          // AG Grid 36.2 range charts can use the existing group column as category.
          api.createRangeChart({
          chartType: "stackedColumn", aggFunc: "sum",
          useGroupColumnAsCategory: api.getRowGroupColumns().length > 0,
          cellRange: { columns: ["agent_id", ...Object.keys(STATUS_LABEL).map((status) => `chart_${status}`)] },
          chartThemeName: resolvedTheme === "dark" ? "floorwalker-dark" : "floorwalker-light",
          chartThemeOverrides: { common: { title: { enabled: true, text: `Amounts by ${groupBy ? "group" : "agent"} and outcome · ${ledgerCurrency}` }, animation: { enabled: !isFilm() && !window.matchMedia("(prefers-reduced-motion: reduce)").matches } } },
          });
        }}>Chart</Button>
        <Button variant="outline" onClick={() => grid.current?.api.exportDataAsExcel({ fileName: "floorwalker-ledger.xlsx", sheetName: "Ledger", columnKeys: exportColumns, skipRowGroups: true, processCellCallback: processExportCell })}>
          <Download size={15} />Excel
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            grid.current?.api.exportDataAsCsv({
              fileName: "floorwalker-ledger.csv",
              columnKeys: exportColumns, skipRowGroups: true, processCellCallback: processExportCell,
            })
          }
        >
          <Download size={15} />
          CSV
        </Button>
      </CardHeader>
      <div className="ledger-views" role="group" aria-label="Saved ledger views">
        {["All", "Waiting", "Investigate stopped requests", "Done by agents"].map(name => <button type="button" key={name} aria-pressed={view === name} onClick={() => chooseView(name)}>{name === "All" ? "All requests" : name}</button>)}
        <span>Filters, columns and grouping are saved per view</span>
      </div>
      <div className="h-[max(520px,calc(100dvh-230px))] min-w-0 w-full">
        <AgGridReact<LedgerEntry>
          suppressAggFuncInHeader
          ref={grid}
          initialState={savedViews.All}
          onStateUpdated={e => remember(e.api)}
          onGridPreDestroyed={e => remember(e.api)}
          theme={theme}
          columnDefs={columns}
          aggFuncs={ledgerAggFuncs}
          rowData={state.ledger}
          animateRows={!isFilm() && !window.matchMedia("(prefers-reduced-motion: reduce)").matches}
          masterDetail
          detailRowAutoHeight
          detailCellRenderer={({ data }: ICellRendererParams<LedgerEntry>) => data ? <DecisionTrace entry={data} /> : null}
          groupDefaultExpanded={0}
          autoGroupColumnDef={{ field: "id", minWidth: 240, cellRendererParams: { suppressCount: false } }}
          onColumnRowGroupChanged={(e) => { setGroupBy(e.api.getRowGroupColumns()[0]?.getColId() ?? ""); e.api.refreshCells({ columns: ["id"], force: true }); }}
          rowSelection={{ mode: "multiRow", enableClickSelection: false, selectAll: "filtered" }}
          cellSelection
          enableCharts={!mixedCurrencies}
          chartThemes={[resolvedTheme === "dark" ? "floorwalker-dark" : "floorwalker-light"]}
          customChartThemes={{ [resolvedTheme === "dark" ? "floorwalker-dark" : "floorwalker-light"]: chartTheme(resolvedTheme === "dark") }}
          chartThemeOverrides={{ common: { title: { enabled: true, text: `Amounts by outcome · ${ledgerCurrency}` }, subtitle: { enabled: true, text: state.ledger.some(row => row.source === "history") ? "Filtered ledger · includes simulated demo history" : "Filtered ledger · live session" } } }}
          sideBar={{ toolPanels: ["columns", "filters"], hiddenByDefault: true }}
          statusBar={{ statusPanels: [
            { statusPanel: LedgerTotals, align: "left" },
            { statusPanel: "agAggregationComponent", statusPanelParams: { aggFuncs: mixedCurrencies ? ["count"] : ["sum", "count"] } },
          ] }}
          excelStyles={[{ id: "currency", dataType: "Number", numberFormat: { format: mixedCurrencies ? '0.00' : `"${ledgerCurrency}" #,##0.00` } }]}
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
