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
export const lightTheme = themeQuartz.withParams({
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
export const darkTheme = lightTheme.withParams({
  backgroundColor: "#171717",
  foregroundColor: "#e5e5e5",
  headerBackgroundColor: "#202020",
  borderColor: "#353535",
  rowHoverColor: "#262626",
  accentColor: "#a3a3a3",
  browserColorScheme: "dark",
});
