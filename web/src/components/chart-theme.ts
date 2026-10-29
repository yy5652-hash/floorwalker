import { BarSeriesModule, CategoryAxisModule, LegendModule, LineSeriesModule, NumberAxisModule, ModuleRegistry as ChartModules, type AgChartTheme } from "ag-charts-community";

// The Overview's charts use AG Charts Community only, so they load without the grids or Enterprise charts.
ChartModules.registerModules([BarSeriesModule, CategoryAxisModule, NumberAxisModule, LineSeriesModule, LegendModule]);
export function chartTheme(dark: boolean): AgChartTheme {
  return {
    baseTheme: dark ? "ag-default-dark" : "ag-default",
    params: { fontFamily: "Inter, sans-serif" },
    overrides: { common: {
      background: { fill: dark ? "#171717" : "#ffffff" },
    } },
  };
}
