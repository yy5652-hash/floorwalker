import { useMemo } from "react";
import { AgCharts } from "ag-charts-react";
import type { AgCartesianChartOptions } from "ag-charts-community";
import { chartTheme } from "./grid-theme";
import { isFilm } from "../auth";
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
  const tapsSaved = changes.reduce(
    (sum, change) => sum + change.impact.tapsSaved,
    0,
  );
  const options = useMemo<AgCartesianChartOptions<Week>>(() => {
    const dark = resolvedTheme === "dark";
    const foreground = dark ? "#a3a3a3" : "#737373";
    return {
      data: weeks,
      height: 210,
      theme: chartTheme(dark),
      animation: { enabled: !isFilm() },
      background: { fill: dark ? "#171717" : "#ffffff" },
      padding: { top: 12, right: 12, bottom: 8, left: 0 },
      legend: { enabled: false },
      series: [
        {
          type: "line",
          xKey: "week",
          yKey: "per100",
          yName: "Taps per 100 money moves",
          stroke: dark ? "#d4d4d4" : "#525252",
          strokeWidth: 2,
          marker: { size: 5, fill: dark ? "#d4d4d4" : "#525252" },
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
        x: { type: "category", label: { color: foreground, fontSize: 10 } },
        y: {
          type: "number",
          min: 0,
          label: { color: foreground, fontSize: 10 },
          gridLine: { style: [{ stroke: dark ? "#353535" : "#e5e5e5" }] },
        },
      },
    };
  }, [weeks, resolvedTheme]);
  return (
    <Card className="min-w-0 gap-3 p-5 shadow-xs">
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
            <div className="text-3xl font-semibold tracking-tight tabular-nums">
              {summary?.per100 ?? latest?.per100 ?? "—"}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              taps per 100 money moves
              {summary && `, last ${summary.days} days`}
            </p>
          </div>
          {weeks.length > 0 && <AgCharts options={options} />}
          {(summary ? summary.moves === 0 : !latest) && (
            <p className="text-xs text-muted-foreground">No money moves yet.</p>
          )}
          {changes.length > 0 && (
            <a
              href="#rules"
              className="text-xs font-medium underline-offset-4 hover:underline"
            >
              {changes.length} suggested changes would save {tapsSaved} taps →
              Rules
            </a>
          )}
        </>
      )}
    </Card>
  );
}
