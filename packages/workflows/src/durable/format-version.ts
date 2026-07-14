/** Shared schema version for durable workflow state and discovery metadata. */
export const DURABLE_FORMAT_VERSION = 2 as const;
export const LEGACY_DURABLE_FORMAT_VERSION = 1 as const;

export type DurableFormatCompatibility = "current" | "legacy" | "unknown";

/** Classify an explicit durable format version without guessing about malformed data. */
export function classifyDurableFormatVersion(value: unknown): DurableFormatCompatibility {
  if (value === DURABLE_FORMAT_VERSION) return "current";
  if (value === LEGACY_DURABLE_FORMAT_VERSION) return "legacy";
  return "unknown";
}
