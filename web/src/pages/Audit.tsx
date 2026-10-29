import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { darkTheme, lightTheme } from "../components/grid-theme";
import { useTheme } from "../components/theme-provider";
import { isFilm } from "../auth";
import { useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Bot, Download, ShieldCheck, User, Cog } from "lucide-react";
import { api, readJSON, workspaceHeaders } from "../api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Resource, useTask } from "../components/Management";

type AuditRow = {
  id: number;
  at: string;
  actor_kind: "user" | "agent" | "system";
  actor_id: string;
  actor_name: string;
  on_behalf_of: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
  hash: string;
  prev_hash?: string;
};
const prefixes = [
  "action.",
  "agent.",
  "key.",
  "rules.",
  "grant.",
  "webhook.",
  "paypal.",
  "billing.",
  "settings.",
  "incident.",
];
function AuditDetail({ data }: ICellRendererParams<AuditRow>) {
  if (!data) return null;
  let detail: unknown = data.detail;
  try { detail = JSON.parse(data.detail ?? "null"); } catch { /* Preserve the recorded evidence. */ }
  return <section aria-label={`Audit entry ${data.id} detail`} className="space-y-3 bg-card p-5">
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(detail, null, 2)}</pre>
    <p className="break-all whitespace-normal font-mono text-xs"><span className="text-muted-foreground">prev_hash → hash</span><br />{data.prev_hash ?? "Not recorded"} → {data.hash}</p>
  </section>;
}
const columns: ColDef<AuditRow>[] = [
  { field: "at", headerName: "Time", width: 230, cellRenderer: "agGroupCellRenderer", valueFormatter: ({ value }) => new Date(value).toLocaleString() },
  { field: "id", headerName: "#", width: 80 },
  { colId: "actor", headerName: "Actor", minWidth: 260, flex: 1,
    valueGetter: ({ data }) => data ? `${data.actor_kind}: ${data.actor_name || data.actor_id}${data.on_behalf_of ? ` · On behalf of ${data.on_behalf_of}` : ""}` : "",
    cellRenderer: ({ data }: ICellRendererParams<AuditRow>) => {
      if (!data) return null;
      const Icon = { user: User, agent: Bot, system: Cog }[data.actor_kind] ?? User;
      return <div className="flex h-full items-center gap-2"><Icon className="size-3.5 shrink-0" /><div className="leading-5">
        <span>{data.actor_kind} · {data.actor_name || data.actor_id}</span>
        {data.on_behalf_of && <span className="block text-xs text-muted-foreground">On behalf of {data.on_behalf_of}</span>}
      </div></div>;
    } },
  { field: "action", headerName: "Action", width: 210, filter: "agTextColumnFilter",
    cellRenderer: ({ value }: ICellRendererParams<AuditRow>) => <Badge variant="secondary">{value?.replaceAll(/[._]/g, " ")}</Badge> },
  { field: "target", headerName: "Target", width: 180, cellClass: "font-mono text-xs" },
  { field: "ip", headerName: "IP", width: 145, cellClass: "font-mono text-xs" },
  { field: "hash", headerName: "Hash", width: 150, cellClass: "font-mono text-xs", valueFormatter: ({ value }) => value?.slice(0, 12), tooltipField: "hash", useValueFormatterForExport: false },
];
export function Audit() {
  const grid = useRef<AgGridReact<AuditRow>>(null);
  const { resolvedTheme } = useTheme();
  const [prefix, setPrefix] = useState("");
  const [verify, setVerify] = useState<{
    ok: boolean;
    entries: number;
    brokenAt?: number;
  } | null>(null);
  const { busy, run } = useTask();
  const query = useInfiniteQuery({
    queryKey: ["audit", prefix],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      api<AuditRow[]>(
        `/api/audit?limit=50&action=${encodeURIComponent(prefix)}${pageParam === undefined ? "" : `&before=${pageParam}`}`,
        "GET",
        undefined,
        signal,
      ),
    getNextPageParam: (last) =>
      last.length === 50 ? last.at(-1)?.id : undefined,
  });
  const rows = useMemo(() => query.data?.pages.flat() ?? [], [query.data]);
  async function download() {
    const response = await fetch("/api/audit.csv", {
      credentials: "include",
      headers: workspaceHeaders(),
    });
    if (!response.ok) {
      await readJSON(response);
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = "floorwalker-audit.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          An accountable history of who did what, and when.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => setVerify(await api("/api/audit/verify")))
            }
          >
            <ShieldCheck />
            Verify integrity
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run(download)}
          >
            <Download />
            Export CSV
          </Button>
          <Button variant="outline" onClick={() => grid.current?.api.exportDataAsExcel({ fileName: "floorwalker-audit.xlsx", sheetName: "Audit" })}>
            <Download />Export Excel
          </Button>
        </div>
      </div>
      {verify && (
        <div
          role="status"
          className={`rounded-lg border p-3 text-sm ${verify.ok ? "tone-allow" : "tone-block"}`}
        >
          {verify.ok
            ? `Chain intact · ${verify.entries} entries`
            : `Changed at entry #${verify.brokenAt}`}
        </div>
      )}
      <div className="flex flex-wrap gap-2" aria-label="Filter audit actions">
        {["", ...prefixes].map((p) => (
          <Button
            key={p}
            size="sm"
            variant={prefix === p ? "secondary" : "outline"}
            aria-pressed={prefix === p}
            onClick={() => setPrefix(p)}
          >
            {p || "All events"}
          </Button>
        ))}
      </div>
      {(
        <Resource query={query}>
          <Card className="overflow-hidden py-0">
            <div className="h-[520px] w-full min-w-0">
              <AgGridReact<AuditRow> ref={grid} rowData={rows} columnDefs={columns}
                theme={resolvedTheme === "dark" ? darkTheme : lightTheme}
                defaultColDef={{ sortable: true, resizable: true, filter: true, cellDataType: false }}
                getRowId={({ data }) => String(data.id)} rowHeight={60} animateRows={!isFilm()}
                masterDetail detailRowAutoHeight detailCellRenderer={AuditDetail}
                onGridReady={({ api }) => api.setFilterModel(prefix ? { action: { filterType: "text", type: "startsWith", filter: prefix } } : null)}
                onRowDataUpdated={({ api }) => api.setFilterModel(prefix ? { action: { filterType: "text", type: "startsWith", filter: prefix } } : null)}
                tooltipShowDelay={250} overlayNoRowsTemplate="No matching events" />
            </div>
            {!query.data?.pages[0]?.length && (
              <div className="space-y-2 p-10 text-center">
                <h3>No matching events</h3>
                <p className="text-sm text-muted-foreground">
                  Try another filter, or create an agent to record your first
                  change.
                </p>
                <Button variant="link" asChild>
                  <a href="/app#agents">Manage agents</a>
                </Button>
              </div>
            )}
          </Card>
          {query.hasNextPage && (
            <Button
              variant="outline"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            CSV exports the latest 500 entries. Excel exports the loaded, filtered entries. Load more to include older entries.
          </p>
        </Resource>
      )}
    </div>
  );
}
