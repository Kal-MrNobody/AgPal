import { studioTheme } from 'ag-studio';

/**
 * One boardroom theme for Studio's UI, grids and charts. Every value points at a CSS variable in app/globals.css, so
 * the shell and the dashboards share one palette and type scale.
 */
const v = (name: string) => `var(--${name})`;
const palette = Object.fromEntries(
  ['#0f7b5f', '#3a6ea5', '#b8892b', '#7b5ea7', '#c2410c', '#2a9d8f', '#13213b', '#9a8c73'].flatMap(
    (c, i) => [
      [`chartPaletteFills${i + 1}Color`, c],
      [`chartPaletteStrokes${i + 1}Color`, c],
    ],
  ),
);

export const boardroomTheme = studioTheme.withParams({
  fontFamily: v('font-sans'),
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
  studioWidgetBorderRadius: 4,
  studioWidgetPadding: 10,
  studioWidgetTitleFontSize: 15,
  studioWidgetTitleFontWeight: 700,
  studioWidgetTitleFontFamily: v('font-display'),
  studioWidgetTitleTextColor: v('ink'),
  ...palette,
});
