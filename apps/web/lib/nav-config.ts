/**
 * Top Navigation Configuration — substrate-topnav-001 (2026-05-24).
 *
 * Substrate ships with one nav entry (Home). Extended per F1-001
 * (cto-prompt-nav-requirement-001) to include SDR product routes.
 */

export type NavLink = {
  href: string;
  label: string;
};

export type NavGroup = {
  label: string;
  links: NavLink[];
};

export type NavConfig = {
  primary: NavLink[];
  groups: NavGroup[];
};

export const NAV_CONFIG: NavConfig = {
  primary: [
    { href: "/", label: "Home" },
    { href: "/campaigns", label: "Campaigns" },
    { href: "/prospects", label: "Prospects" },
    { href: "/pipeline", label: "Pipeline" },
  ],
  groups: [
    {
      label: "Operations",
      links: [
        { href: "/campaigns", label: "Campaigns" },
        { href: "/prospects", label: "Prospects" },
        { href: "/pipeline", label: "Pipeline" },
      ],
    },
    {
      label: "Settings",
      links: [
        { href: "/settings/sending", label: "Sending" },
        { href: "/settings/icp", label: "Ideal Customer Profile" },
      ],
    },
  ],
};
