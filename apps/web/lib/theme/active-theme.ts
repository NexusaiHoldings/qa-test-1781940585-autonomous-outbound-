/**
 * active-theme — the resolved ThemeContract this company wears.
 * Written by provisioning (_step_substrate_install): an approved mood
 * board's derived theme wins, else the CMO's authored ThemeContract
 * (company-theme-authoring-001 / visual phase 3b). Do NOT hand-edit.
 */
import type { ThemeContract } from "./contract";

export const activeTheme: ThemeContract = {
  "type": {
    "fontBody": "inter",
    "fontHeading": "inter"
  },
  "color": {
    "bg": "#f8f9fb",
    "text": "#1a2332",
    "accent": "#1a4fd6",
    "border": "#dde2ea",
    "danger": "#b91c1c",
    "success": "#166534",
    "surface": "#ffffff",
    "textMuted": "#4f5f74",
    "accentText": "#ffffff",
    "surfaceAlt": "#eef1f6",
    "borderStrong": "#b8c2d0"
  },
  "shape": {
    "radius": 6
  }
};
