import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
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
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
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
  why,
  type LedgerEntry,
  type State,
  personName,
} from "../api";
import { DecisionCard } from "./Verdict";
import { StatusPill } from "./UI";

// AG Grid 36.2: https://www.ag-grid.com/react-data-grid/theming/
ModuleRegistry.registerModules([AllCommunityModule]);
const lightTheme = themeQuartz.withParams({
  fontFamily: "Inter, sans-serif",
  fontSize: 12,
  headerFontSize: 11,
  headerFontWeight: 600,
  backgroundColor: "#ffffff",
  foregroundColor: "#404040",
  headerBackgroundColor: "#fafafa",
  borderColor: "#e5e5e5",
  rowHoverColor: "#f5f5f5",
  accentColor: "#525252",
  wrapperBorderRadius: 0,
  spacing: 6,
  browserColorScheme: "light",
});
const darkTheme = lightTheme.withParams({
  backgroundColor: "#171717",
  foregroundColor: "#e5e5e5",
  headerBackgroundColor: "#202020",
  borderColor: "#353535",
  rowHoverColor: "#262626",
  accentColor: "#a3a3a3",
  browserColorScheme: "dark",
});
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
            {new Date(entry.created_at).toLocaleString()} · policy{" "}
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
                {entry.paypal_result
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
export function Ledger({
  state,
  selectedId,
}: {
  state: State;
  selectedId?: number;
}) {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? darkTheme : lightTheme;
  const grid = useRef<AgGridReact<LedgerEntry>>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<number | undefined>(selectedId);
  useEffect(() => setSelected(selectedId), [selectedId]);
  const entry = state.ledger.find((e) => e.id === selected);
  const columns = useMemo<ColDef<LedgerEntry>[]>(
    () => [
      { field: "id", headerName: "#", width: 55, minWidth: 45 },
      {
        field: "created_at",
        headerName: "Time",
        width: 85,
        valueFormatter: (p) =>
          new Date(p.value).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
      },
      {
        field: "agent_id",
        headerName: "Agent",
        width: 125,
        valueGetter: (p) => (p.data ? agentName(state, p.data.agent_id) : ""),
      },
      {
        field: "kind",
        headerName: "Action",
        width: 80,
        valueFormatter: (p) => (p.value === "refund" ? "Refund" : "Payout"),
      },
      {
        field: "amount",
        headerName: "Amount",
        width: 125,
        valueGetter: (p) => (p.data ? amountOf(p.data) : 0),
        valueFormatter: (p) =>
          p.data
            ? `${money(amountOf(p.data))}${p.data.approved_amount != null && p.data.approved_amount !== p.data.amount ? ` of ${money(p.data.amount)}` : ""}`
            : "",
        cellClass: "tabular-nums font-medium",
      },
      {
        field: "counterparty",
        headerName: "To",
        flex: 1,
        minWidth: 130,
        valueFormatter: (p) => personName(p.value),
      },
      {
        field: "status",
        headerName: "Outcome",
        width: 170,
        valueFormatter: (p) => STATUS_LABEL[p.value as LedgerEntry["status"]],
        cellRenderer: (p: ICellRendererParams<LedgerEntry>) =>
          p.data ? <StatusPill status={p.data.status} /> : null,
      },
      {
        headerName: "Why",
        colId: "why",
        flex: 1.3,
        minWidth: 120,
        valueGetter: (p) => (p.data ? why(p.data) : ""),
        tooltipValueGetter: (p) => p.value,
      },
      {
        field: "paypal_ref",
        headerName: "PayPal ref",
        width: 115,
        cellClass: "font-mono text-xs",
      },
    ],
    [state.agents],
  );
  return (
    <Card className="min-w-0 gap-0 overflow-hidden py-0 shadow-xs">
      <CardHeader className="flex flex-wrap items-center gap-4 p-5">
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
                      ? STATUS_LABEL[row.status]
                      : p.value;
                const text = String(raw ?? "");
                return /^[\s]*[=+@\-\t\r\n]/.test(text) ? `'${text}` : text;
              },
            })
          }
        >
          <Download size={15} />
          Export CSV
        </Button>
      </CardHeader>
      <div className="h-[520px] min-w-0 w-full">
        <AgGridReact<LedgerEntry>
          ref={grid}
          theme={theme}
          columnDefs={columns}
          rowData={state.ledger}
          defaultColDef={{ sortable: true, resizable: true }}
          quickFilterText={search}
          getRowId={(p) => String(p.data.id)}
          rowHeight={58}
          headerHeight={42}
          onRowClicked={(e) => {
            if (e.data) {
              setSelected(e.data.id);
              location.hash = `ledger/${e.data.id}`;
            }
          }}
          onCellKeyDown={(e) => {
            if ((e.event as KeyboardEvent)?.key === "Enter" && e.data) {
              setSelected(e.data.id);
              location.hash = `ledger/${e.data.id}`;
            }
          }}
          overlayNoRowsTemplate="No money moves yet. Let an agent handle an inbox item."
          tooltipShowDelay={250}
        />
      </div>
      <div className="flex flex-wrap justify-between gap-2 border-t px-5 py-3 text-[11px] text-muted-foreground">
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
