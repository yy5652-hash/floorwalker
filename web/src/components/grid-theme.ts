import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";
import { CellSelectionModule, ColumnsToolPanelModule, ColumnMenuModule, ExcelExportModule, FiltersToolPanelModule, LicenseManager, MasterDetailModule, RowGroupingModule, SetFilterModule, StatusBarModule } from "ag-grid-enterprise";
import { LicenseManager as ChartsLicenseManager } from "ag-charts-enterprise";
export { chartTheme } from "./chart-theme";

// The Enterprise key, when set, is applied where the grids (and the grid's integrated Enterprise charts) load.
const agLicenseKey = import.meta.env.VITE_AG_GRID_LICENSE_KEY;
if (agLicenseKey) {
  LicenseManager.setLicenseKey(agLicenseKey);
  // Charts 14.2 moved licensing from AgCharts to LicenseManager.
  ChartsLicenseManager.setLicenseKey(agLicenseKey);
}

// AG Grid 36.2: https://www.ag-grid.com/react-data-grid/theming/
ModuleRegistry.registerModules([
  AllCommunityModule, MasterDetailModule, RowGroupingModule, CellSelectionModule,
  ColumnsToolPanelModule, FiltersToolPanelModule, ColumnMenuModule, SetFilterModule,
  StatusBarModule, ExcelExportModule,
]);
// CSS tokens keep the table, app, and outcomes in the same light/dark palette.
export const lightTheme = themeQuartz.withParams({
  fontFamily: '"Manrope Variable", sans-serif',
  fontSize: 15,
  headerFontSize: 12,
  headerFontWeight: 500,
  backgroundColor: "var(--card)",
  foregroundColor: "var(--foreground)",
  headerTextColor: "var(--muted-foreground)",
  headerBackgroundColor: "var(--card)",
  borderColor: "var(--border)",
  rowBorder: { color: "var(--border)", width: 1 },
  rowHoverColor: "var(--muted)",
  accentColor: "var(--primary)",
  headerColumnBorder: false,
  columnBorder: false,
  headerColumnResizeHandleColor: "transparent",
  wrapperBorderRadius: 0,
  spacing: 8,
  rowHeight: 64,
  headerHeight: 48,
  browserColorScheme: "light",
});
export const darkTheme = lightTheme.withParams({ browserColorScheme: "dark" });
