export const NAV_CONFIG = {
  primary: [
    { href: "/", label: "Home" },
    { href: "/campaigns", label: "Campaigns" },
    { href: "/prospects", label: "Prospects" },
    { href: "/pipeline", label: "Pipeline" },
  ],
  groups: [
    {
      label: "Operations",
      items: [
        { href: "/campaigns", label: "Campaigns" },
        { href: "/prospects", label: "Prospects" },
        { href: "/pipeline", label: "Pipeline" },
      ],
    },
    {
      label: "Settings",
      items: [
        { href: "/settings/sending", label: "Sending" },
        { href: "/settings/icp", label: "Ideal Customer Profile" },
      ],
    },
  ],
} as const;
