import type { ThemeConfig } from "antd";

/**
 * TokenTrail design tokens — an interpretation of the "Notion" design language:
 * a warm paper-soft canvas, near-black Inter type with tight tracking, exactly
 * one structural accent (Notion blue) reserved for CTAs/links/active state, a
 * decorative-only multi-colour sticker palette for data viz, and a single deep
 * indigo "night" hero. Elevation is hairline + barely-there layered shadow.
 *
 * See DESIGN (Notion). Keep {@link tokens} the single source of truth; the AntD
 * {@link notionTheme} and the global stylesheet both read from these values.
 */
export const tokens = {
  color: {
    // Single structural accent
    primary: "#0075de",
    primaryActive: "#005bab",
    // Dark "night" hero band
    secondary: "#213183",
    // Surfaces
    canvasSoft: "#f6f5f4", // warm paper — page background + footer
    surface: "#ffffff", // cards, panels, fields
    hairline: "#e6e6e6",
    // Text
    ink: "#191918",
    inkSecondary: "#31302e",
    inkMuted: "#615d59",
    inkFaint: "#a39e98",
    onPrimary: "#ffffff",
    // Decorative sticker palette (illustration / charts / dots only)
    sky: "#62aef0",
    purple: "#d6b6f6",
    purpleDeep: "#391c57",
    pink: "#ff64c8",
    orange: "#dd5b00",
    teal: "#2a9d99",
    green: "#1aae39",
    brown: "#523410",
  },
  radius: { xs: 4, sm: 5, md: 8, lg: 12, xl: 16, full: 9999 },
  space: { xxs: 4, xs: 8, sm: 12, md: 16, lg: 24, xl: 28, xxl: 32 },
  font: {
    ui: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  },
} as const;

const c = tokens.color;

/**
 * Categorical chart palette — Notion's decorative sticker colours. These paint
 * data series only (never CTAs or structure). Blue leads as the primary series.
 */
export const chartPalette = [
  c.primary, // #0075de blue
  c.teal, // #2a9d99
  c.orange, // #dd5b00
  c.pink, // #ff64c8
  c.green, // #1aae39
  c.sky, // #62aef0
  c.purpleDeep, // #391c57
  c.brown, // #523410
] as const;

/** Primary single-series accent (line/area stroke). */
export const chartPrimary = c.primary;

/** Notion's barely-there Level-1 elevation — many near-transparent layers. */
const softShadow =
  "rgba(0,0,0,0.01) 0 0.175px 1.04px, rgba(0,0,0,0.02) 0 0.8px 2.93px, " +
  "rgba(0,0,0,0.027) 0 2.03px 7.85px, rgba(0,0,0,0.04) 0 4px 18px";

export const notionTheme: ThemeConfig = {
  token: {
    colorPrimary: c.primary,
    colorLink: c.primary,
    colorLinkHover: c.primaryActive,
    colorInfo: c.primary,
    colorTextBase: c.ink,
    colorText: c.ink,
    colorTextSecondary: c.inkSecondary,
    colorBgBase: c.surface,
    colorBgLayout: c.canvasSoft,
    colorBgContainer: c.surface,
    colorBorder: c.hairline,
    colorBorderSecondary: c.hairline,
    borderRadius: tokens.radius.md,
    borderRadiusLG: tokens.radius.lg,
    borderRadiusSM: tokens.radius.sm,
    borderRadiusXS: tokens.radius.xs,
    fontFamily: tokens.font.ui,
    fontFamilyCode: tokens.font.mono,
    fontSize: 14,
    controlHeight: 36,
    colorPrimaryActive: c.primaryActive,
    wireframe: false,
  },
  components: {
    Layout: {
      siderBg: c.surface,
      headerBg: c.surface,
      headerHeight: 56,
      bodyBg: c.canvasSoft,
      headerPadding: "0 24px",
    },
    Menu: {
      itemBg: "transparent",
      subMenuItemBg: "transparent",
      itemColor: c.inkSecondary,
      itemHoverColor: c.ink,
      itemHoverBg: "rgba(0,0,0,0.04)",
      itemSelectedBg: "rgba(0,117,222,0.10)",
      itemSelectedColor: c.primary,
      itemBorderRadius: tokens.radius.sm,
      itemMarginInline: 8,
      itemHeight: 40,
    },
    Button: {
      fontWeight: 500,
      primaryShadow: "none",
      defaultShadow: "none",
      dangerShadow: "none",
      controlHeight: 36,
    },
    Card: {
      borderRadiusLG: tokens.radius.lg,
      colorBorderSecondary: c.hairline,
      headerFontSize: 16,
      boxShadowTertiary: softShadow,
    },
    Table: {
      headerBg: c.surface,
      headerColor: c.inkMuted,
      headerSplitColor: "transparent",
      borderColor: c.hairline,
      rowHoverBg: c.canvasSoft,
      cellFontSize: 14,
    },
    Statistic: { titleFontSize: 13, contentFontSize: 28 },
    Tag: {
      borderRadiusSM: tokens.radius.xs,
      defaultBg: c.canvasSoft,
      defaultColor: c.inkSecondary,
    },
    Input: { borderRadius: tokens.radius.xs, activeBorderColor: c.primary },
    Select: { borderRadius: tokens.radius.md },
    Segmented: { borderRadius: tokens.radius.md, itemSelectedBg: c.surface, itemSelectedColor: c.primary },
    Tabs: { inkBarColor: c.primary, itemSelectedColor: c.ink, itemActiveColor: c.ink },
    Modal: { borderRadiusLG: tokens.radius.lg },
  },
};
