import { weeklyMoney } from "../lib/weekly-money";
import { useMemo } from "react";
import { AgCharts } from "ag-charts-react";
import type { AgCartesianChartOptions } from "ag-charts-community";
import { money, type State } from "../api";
import { isFilm } from "../auth";
import { chartTheme } from "./grid-theme";
import { useTheme } from "./theme-provider";
import { Card } from "./ui/card";

const series = [
  ["executed", "Done automatically", "#059669"],
  ["approved", "Approved by you", "#6366f1"],
  ["declined", "Declined", "#d97706"],
  ["blocked", "Blocked", "#e11d48"],
] as const;
export function MoneyChart({ state }: { state: State }) {
  const { resolvedTheme } = useTheme();
  const data = useMemo(() => {
    const latest = Math.max(...state.ledger.map((row) => Date.parse(row.created_at)).filter(Number.isFinite));
    return weeklyMoney(state.ledger, isFilm() && Number.isFinite(latest) ? latest : Date.now());
  }, [state.ledger]);
  const options = useMemo<AgCartesianChartOptions>(() => ({
    data, height: 290, theme: chartTheme(resolvedTheme === "dark"),
    animation: { enabled: !isFilm() },
    legend: { enabled: true, position: "bottom" },
    series: series.map(([yKey, yName, fill]) => ({
      type: "bar", direction: "vertical", stacked: true, xKey: "week", yKey, yName, fill,
      tooltip: { renderer: ({ datum }) => ({ title: `Week of ${datum.week} (UTC)`, data: [{ label: yName, value: money(datum[yKey]) }] }) },
    })),
    axes: {
      x: { type: "category", label: { fontSize: 10, formatter: ({ value }) => String(value).slice(5) } },
      y: { type: "number", min: 0, label: { fontSize: 10, formatter: ({ value }) => money(value) } },
    },
  }), [data, resolvedTheme]);
  return <Card className="min-w-0 gap-3 p-5 shadow-xs">
    <h2>Money moved per week</h2>
    <p className="text-xs text-muted-foreground">Last 12 weeks · weeks start Monday (UTC). Declined and blocked amounts were stopped, not moved.</p>
    <AgCharts options={options} />
    {!data.some((week) => series.some(([key]) => week[key] > 0)) && <p className="text-xs text-muted-foreground">No completed or stopped money moves in this period.</p>}
  </Card>;
}
