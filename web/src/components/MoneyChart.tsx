import { weeklyMoney } from "../lib/weekly-money";
import { useMemo } from "react";
import { AgCharts } from "ag-charts-react";
import type { AgCartesianChartOptions } from "ag-charts-community";
import { money, type State } from "../api";
import { chartTheme, chartColor } from "./chart-theme";
import { useTheme } from "./theme-provider";
import { Card } from "./ui/card";

const series = [
  ["executed", "Done automatically", "--chart-1"],
  ["approved", "Approved by you", "--chart-2"],
  ["declined", "Declined", "--chart-5"],
  ["blocked", "Blocked", "--chart-4"],
] as const;
export function MoneyChart({ state }: { state: State }) {
  const { resolvedTheme } = useTheme();
  const latest = Math.max(...state.ledger.filter(row => series.some(([key]) => key === row.status)).map(row => Date.parse(row.created_at)).filter(Number.isFinite));
  const data = useMemo(() => {
    if (!Number.isFinite(latest)) return [];
    const weeks = weeklyMoney(state.ledger, latest);
    const hasData = (week: typeof weeks[number]) => state.ledger.some(row => series.some(([key]) => key === row.status) && Date.parse(row.created_at) >= Date.parse(week.week) && Date.parse(row.created_at) < Date.parse(week.week) + 7 * 86400000);
    return weeks.slice(Math.max(0, weeks.findIndex(hasData)), weeks.findLastIndex(hasData) + 1);
  }, [state.ledger, latest]);
  const currentWeek = new Date(); currentWeek.setUTCHours(0, 0, 0, 0); currentWeek.setUTCDate(currentWeek.getUTCDate() - (currentWeek.getUTCDay() + 6) % 7);
  const oldActivity = latest < currentWeek.getTime();
  const options = useMemo<AgCartesianChartOptions>(() => ({
    data, height: 290, theme: chartTheme(resolvedTheme === "dark"),
    animation: { enabled: false },
    legend: { enabled: true, position: "bottom" },
    series: series.map(([yKey, yName, fill]) => ({
      type: "bar", direction: "vertical", stacked: true, xKey: "week", yKey, yName, fill: chartColor(fill),
      tooltip: { renderer: ({ datum }) => ({ title: `Week of ${datum.week} (UTC)`, data: [{ label: yName, value: money(datum[yKey]) }] }) },
    })),
    axes: {
      x: { type: "category", label: { autoRotate: false, rotation: 0, fontSize: 14, minSpacing: 20, formatter: ({ value }) => String(value).slice(5) } },
      y: { type: "number", min: 0, label: { fontSize: 14, formatter: ({ value }) => `$${value.toLocaleString("en-US")}` } },
    },
  }), [data, resolvedTheme]);
  return <Card className="min-w-0 gap-3 p-5 shadow-xs">
    <h2>Money moved per week</h2>
    <p className="text-xs text-muted-foreground">{oldActivity && Number.isFinite(latest) ? `Last activity · ${new Date(latest).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}. ` : ""}Up to 12 weeks ending with recorded activity; weeks start Monday (UTC). Declined and blocked amounts were stopped, not moved.</p>
    {data.length > 0 && <AgCharts options={options} />}
    {!data.some((week) => series.some(([key]) => week[key] > 0)) && <p className="text-xs text-muted-foreground">No completed or stopped money moves in this period.</p>}
  </Card>;
}
