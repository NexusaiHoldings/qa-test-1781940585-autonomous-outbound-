/**
 * ICP targeting filter validation for SDR campaigns.
 *
 * Enforces the CEO briefing's primary-segment constraints: US-only scope
 * (CAN-SPAM), sub-10-employee professional services firms, four allowed
 * industry verticals.
 */

export type IndustryVertical =
  | "IT MSP"
  | "accounting"
  | "legal"
  | "marketing agency";

export type Geography = "US";

export interface IcpFilterInput {
  industryVerticals: string[];
  headcountMin: number;
  headcountMax: number;
  geographies: string[];
  titleKeywords: string[];
}

export interface IcpValidationError {
  field: string;
  message: string;
}

export interface IcpValidationResult {
  valid: boolean;
  errors: IcpValidationError[];
}

export const ALLOWED_VERTICALS: readonly IndustryVertical[] = [
  "IT MSP",
  "accounting",
  "legal",
  "marketing agency",
] as const;

export const ALLOWED_GEOGRAPHIES: readonly Geography[] = ["US"] as const;

/** CEO briefing primary_segment cap: sub-10-employee firms. */
export const PRIMARY_SEGMENT_MAX_HEADCOUNT = 10;
export const PRIMARY_SEGMENT_MIN_HEADCOUNT = 1;

export function validateIcpFilter(
  input: Partial<IcpFilterInput>,
): IcpValidationResult {
  const errors: IcpValidationError[] = [];

  const verticals = input.industryVerticals ?? [];
  if (verticals.length === 0) {
    errors.push({
      field: "industryVerticals",
      message: "Select at least one industry vertical.",
    });
  } else {
    const invalid = verticals.filter(
      (v) => !(ALLOWED_VERTICALS as readonly string[]).includes(v),
    );
    if (invalid.length > 0) {
      errors.push({
        field: "industryVerticals",
        message: `Unrecognised vertical(s): ${invalid.join(", ")}`,
      });
    }
  }

  const min = input.headcountMin ?? NaN;
  const max = input.headcountMax ?? NaN;

  if (
    !Number.isFinite(min) ||
    !Number.isInteger(min) ||
    min < PRIMARY_SEGMENT_MIN_HEADCOUNT
  ) {
    errors.push({
      field: "headcountMin",
      message: `Minimum headcount must be a whole number ≥ ${PRIMARY_SEGMENT_MIN_HEADCOUNT}.`,
    });
  }

  if (!Number.isFinite(max) || !Number.isInteger(max) || max < 1) {
    errors.push({
      field: "headcountMax",
      message: "Maximum headcount must be a positive whole number.",
    });
  } else if (max > PRIMARY_SEGMENT_MAX_HEADCOUNT) {
    errors.push({
      field: "headcountMax",
      message: `Maximum headcount cannot exceed ${PRIMARY_SEGMENT_MAX_HEADCOUNT} (primary segment cap).`,
    });
  }

  if (
    Number.isFinite(min) &&
    Number.isInteger(min) &&
    Number.isFinite(max) &&
    Number.isInteger(max) &&
    min > max
  ) {
    errors.push({
      field: "headcountMin",
      message: "Minimum headcount must not exceed maximum headcount.",
    });
  }

  const geos = input.geographies ?? [];
  if (geos.length === 0) {
    errors.push({
      field: "geographies",
      message: "Select at least one geography.",
    });
  } else {
    const invalidGeos = geos.filter(
      (g) => !(ALLOWED_GEOGRAPHIES as readonly string[]).includes(g),
    );
    if (invalidGeos.length > 0) {
      errors.push({
        field: "geographies",
        message: "Only US geography is supported at MVP scope (CAN-SPAM compliance).",
      });
    }
  }

  const keywords = input.titleKeywords ?? [];
  if (keywords.length === 0) {
    errors.push({
      field: "titleKeywords",
      message: "Enter at least one job title keyword.",
    });
  } else {
    const hasBlank = keywords.some((k) => typeof k !== "string" || k.trim().length === 0);
    if (hasBlank) {
      errors.push({
        field: "titleKeywords",
        message: "Job title keywords must be non-empty strings.",
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Parse a comma-separated keyword string into a trimmed, non-empty array. */
export function parseKeywordsFromString(raw: string): string[] {
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}
