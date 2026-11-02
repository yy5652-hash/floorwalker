import { useMemo } from "react";
import { AgCharts } from "ag-charts-react";
import type { AgCartesianChartOptions } from "ag-charts-community";
import { chartTheme, chartColor } from "./chart-theme";
import { useTheme } from "./theme-provider";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { type LearnedRules, type State } from "../api";
import { emptyLearnedRules, useLearnedRules } from "../hooks/use-learned-rules";

type Week = LearnedRules["weeks"][number];

export function TapsChart({ state }: { state: State }) {
  const query = useLearnedRules(state);
  const { weeks, changes, summary } = query.data ?? emptyLearnedRules;
  const { resolvedTheme } = useTheme();
  const latest = weeks.findLast((week) => week.moves > 0);
  const firstIndex = weeks.findIndex(week => week.moves > 0);
  const lastIndex = weeks.findLastIndex(week => week.moves > 0);
  const lastActivity = state.ledger.filter(entry => entry.kind === "refund" || entry.kind === "payout").reduce<string | null>((latest, entry) => !latest || entry.created_at > latest ? entry.created_at : latest, null);
  const currentWeek = new Date(); currentWeek.setUTCHours(0, 0, 0, 0); currentWeek.setUTCDate(currentWeek.getUTCDate() - currentWeek.getUTCDay());
  const oldActivity = !!lastActivity && Date.parse(lastActivity) < currentWeek.getTime();
  const best = [...changes].sort((a, b) => b.impact.tapsSaved - a.impact.tapsSaved)[0];
  const options = useMemo<AgCartesianChartOptions<Omit<Week, "per100"> & { per100?: number }>>(() => {
    const dark = resolvedTheme === "dark";
    const foreground = chartColor("--muted-foreground");
    return {
      // A week without money moves is a gap, not zero taps.
      data: weeks.slice(Math.max(0, firstIndex), lastIndex + 1).map((week) => (week.moves ? week : { ...week, per100: undefined })),
      height: 210,
      theme: chartTheme(dark),
      animation: { enabled: false },
      background: { fill: chartColor("--background") },
      padding: { top: 12, right: 12, bottom: 8, left: 0 },
      legend: { enabled: false },
      series: [
        {
          type: "line",
          xKey: "week",
          yKey: "per100",
          yName: "Taps per 100 money moves",
          stroke: chartColor("--chart-2"),
          strokeWidth: 2,
          marker: { size: 5, fill: chartColor("--chart-2") },
          tooltip: {
            renderer: ({ datum }) => ({
              title: datum.week,
              data: [
                { label: "taps/moves", value: `${datum.taps}/${datum.moves}` },
              ],
            }),
          },
        },
      ],
      axes: {
        x: { type: "category", label: { color: foreground, fontSize: 14, autoRotate: false, rotation: 0, minSpacing: 24, formatter: ({ value }) => String(value).slice(5) } },
        y: {
          type: "number",
          min: 0,
          label: { color: foreground, fontSize: 14 },
          gridLine: { style: [{ stroke: chartColor("--border") }] },
        },
      },
    };
  }, [weeks, firstIndex, lastIndex, resolvedTheme]);
  return (
    <Card className="taps-primary min-w-0 gap-3 p-5 shadow-none">
      <h2>How often agents need you</h2>
      {query.isPending ? (
        <div
          role="status"
          aria-label="Loading weekly activity"
          className="space-y-3"
        >
          <Skeleton className="h-10 w-24" />
          <Skeleton className="h-[210px] w-full" />
          <span className="sr-only">Loading weekly activity…</span>
        </div>
      ) : query.isError ? (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-muted-foreground">
            Couldn't load weekly activity.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : (
        <>
          <div>
            <div className="chart-number">
              {summary?.per100 ?? latest?.per100 ?? "—"}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              taps per 100 money moves
              {summary && `, last ${summary.days} days`}
            </p>
          </div>
          <div className="taps-trend">
          {latest && <AgCharts options={options} />}
          {oldActivity && lastActivity && <p className="text-xs text-muted-foreground">Last activity · <time dateTime={lastActivity}>{new Date(lastActivity).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}</time></p>}
          {(summary ? summary.moves === 0 : !latest) && (
            <p className="text-xs text-muted-foreground">No money moves yet.</p>
          )}
          </div>
          {best && (
            <a
              href="#rules"
              className="taps-suggestion text-sm underline-offset-4 hover:underline"
            >
              <strong>{best.title}</strong><span>Saves {best.impact.tapsSaved} taps in replay · {best.impact.tapsPer100.before} → {best.impact.tapsPer100.after} per 100 moves</span><span>See suggestions →</span>
            </a>
          )}
        </>
      )}
    </Card>
  );
}
