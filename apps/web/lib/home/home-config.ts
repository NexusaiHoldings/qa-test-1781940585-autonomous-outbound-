/**
 * home-config — the company's root surface (company-root-landing-001).
 * Written by provisioning (_step_substrate_install) from CTO home_mode
 * + CMO positioning. Do NOT hand-edit.
 */
export interface HomeCta {
  label: string;
  href: string;
}

export interface HomeConfig {
  mode: "landing" | "conversation";
  headline?: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
}

export const homeConfig: HomeConfig = {
  "mode": "landing",
  "headline": "Your First SDR Costs $499/mo \u2014 Not $80,000/Year",
  "subhead": "An autonomous AI SDR agent that researches prospects across Apollo, LinkedIn, and company news, writes hyper-personalized cold emails referencing live trigger events, handles 2-3 reply touches, and books qualified meetings directly into the"
};
