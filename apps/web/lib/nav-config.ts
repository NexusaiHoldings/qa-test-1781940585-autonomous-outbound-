export const NAV_CONFIG = {
  primary: [
    { label: "Home", href: "/", icon: "Home" },
    { label: "Campaigns", href: "/campaigns", icon: "Megaphone" },
    { label: "Prospects", href: "/prospects", icon: "Users" },
    { label: "Pipeline", href: "/pipeline", icon: "BarChart3" },
  ],
  groups: [
    {
      label: "Settings",
      items: [
        { label: "Sending", href: "/settings/sending", icon: "Mail" },
        { label: "ICP", href: "/settings/icp", icon: "Target" },
      ],
    },
  ],
} as const;
