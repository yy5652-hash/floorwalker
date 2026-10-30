import { BarSeriesModule, CategoryAxisModule, LegendModule, LineSeriesModule, NumberAxisModule, ModuleRegistry as ChartModules, type AgChartTheme } from "ag-charts-community";

// The Overview's charts use AG Charts Community only, so they load without the grids or Enterprise charts.
ChartModules.registerModules([BarSeriesModule, CategoryAxisModule, NumberAxisModule, LineSeriesModule, LegendModule]);
// Canvas charts require resolved colours; CSS remains the source of truth.
export function chartColor(token: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}
export function chartTheme(dark: boolean): AgChartTheme {
  const foreground = chartColor("--muted-foreground");
  const palette = [1, 2, 3, 4, 5].map(n => chartColor(`--chart-${n}`));
  return {
    baseTheme: dark ? "ag-default-dark" : "ag-default",
    palette: { fills: palette, strokes: palette },
    params: {
      fontFamily: '"Manrope Variable", sans-serif',
      foregroundColor: foreground,
      backgroundColor: chartColor("--background"),
      accentColor: chartColor("--primary"),
      tooltipBackgroundColor: chartColor("--card"),
      tooltipTextColor: chartColor("--foreground"),
    },
    overrides: { common: {
      background: { fill: chartColor("--background") },
      legend: { item: { label: { fontSize: 12, color: foreground }, marker: { size: 7 } } },
      axes: {
        category: { line: { enabled: false }, tick: { enabled: false }, label: { autoRotate: false, rotation: 0, fontSize: 11, color: foreground, minSpacing: 24 } },
        number: { line: { enabled: false }, tick: { enabled: false }, label: { fontSize: 11, color: foreground }, gridLine: { style: [{ stroke: chartColor("--border"), lineDash: [3, 5] }] } },
      },
    } },
  };
}
