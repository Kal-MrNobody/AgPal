import { studioTheme } from 'ag-studio';

/**
 * One boardroom theme for Studio's UI, grids and charts. Every value points at a CSS variable in app/globals.css, so
 * the shell and the dashboards share one palette and type scale.
 */
const v = (name: string) => `var(--${name})`;
const palette = Object.fromEntries(
  ['#0070e0', '#00a3a3', '#f2a900', '#7b61ff', '#e5484d', '#3b9b5c', '#8a94a6', '#ff7a45'].flatMap(
    (c, i) => [
      [`chartPaletteFills${i + 1}Color`, c],
      [`chartPaletteStrokes${i + 1}Color`, c],
    ],
  ),
);

export const boardroomTheme = studioTheme.withParams({
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  fontSize: 13,
  textColor: v('ink'),
  foregroundColor: v('ink'),
  subtleTextColor: v('muted'),
  backgroundColor: v('panel'),
  borderColor: v('line'),
  accentColor: v('accent'),
  studioWrapperBorder: false,
  studioWrapperBackgroundColor: v('bg'),
  studioCanvasBorder: false,
  studioCanvasShadow: false,
  studioCanvasBackgroundColor: v('bg'),
  studioCanvasPadding: 12,
  studioWidgetBackgroundColor: v('panel'),
  studioWidgetBorder: { width: 1, color: v('line') },
  studioWidgetBorderRadius: 10,
  studioWidgetPadding: 10,
  studioWidgetTitleFontSize: 14,
  studioWidgetTitleFontWeight: 600,
  studioWidgetTitleTextColor: v('ink'),
  ...palette,
});
