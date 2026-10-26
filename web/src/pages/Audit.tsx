import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Bot, Download, ShieldCheck, User, Cog } from "lucide-react";
import { api, readJSON, workspaceHeaders } from "../api";
import { isFilm } from "../auth";
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
];
export function Audit() {
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
    enabled: !isFilm(),
  });
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
    link.download = "allowance-audit.csv";
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
            disabled={busy || isFilm()}
            onClick={() =>
              void run(async () => setVerify(await api("/api/audit/verify")))
            }
          >
            <ShieldCheck />
            Verify integrity
          </Button>
          <Button
            variant="outline"
            disabled={busy || isFilm()}
            onClick={() => void run(download)}
          >
            <Download />
            Export CSV
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
      {isFilm() ? (
        <Card className="p-6">Audit tools are unavailable during filming.</Card>
      ) : (
        <Resource query={query}>
          <Card className="overflow-hidden py-0">
            <div className="overflow-x-auto">
              <table className="manage-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>IP</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data?.pages.flat().map((row) => {
                    const Icon =
                      { user: User, agent: Bot, system: Cog }[row.actor_kind] ||
                      User;
                    let detail: unknown = row.detail;
                    try {
                      detail = JSON.parse(row.detail || "null");
                    } catch {
                      /* Keep original audit evidence. */
                    }
                    return (
                      <tr key={row.id}>
                        <td className="whitespace-nowrap text-xs">
                          {new Date(row.at).toLocaleString()}
                          <span className="block text-muted-foreground">
                            #{row.id}
                          </span>
                        </td>
                        <td>
                          <span className="flex items-center gap-2">
                            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                            {row.actor_name || row.actor_id}
                          </span>
                          {row.on_behalf_of && (
                            <span className="mt-1 block text-xs text-muted-foreground">
                              On behalf of {row.on_behalf_of}
                            </span>
                          )}
                        </td>
                        <td>
                          <Badge variant="secondary">
                            {row.action.replaceAll(/[._]/g, " ")}
                          </Badge>
                        </td>
                        <td className="max-w-52 break-all font-mono text-xs">
                          {row.target ?? "—"}
                        </td>
                        <td className="font-mono text-xs">{row.ip ?? "—"}</td>
                        <td>
                          <details>
                            <summary className="cursor-pointer text-xs">
                              View detail
                            </summary>
                            <pre className="mt-2 max-h-64 max-w-sm overflow-auto whitespace-pre-wrap break-all text-xs">
                              {JSON.stringify(detail, null, 2)}
                            </pre>
                            <p className="mt-2 max-w-sm break-all font-mono text-[10px] text-muted-foreground">
                              Hash: {row.hash}
                            </p>
                          </details>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
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
            CSV exports the latest 500 entries. The table can load older
            entries.
          </p>
        </Resource>
      )}
    </div>
  );
}
