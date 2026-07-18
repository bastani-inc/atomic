/** Single current schema version for DBOS workflow state and metadata. */
export const DURABLE_FORMAT_VERSION = 3 as const;

export function isCurrentDurableFormat(value: unknown): boolean {
  return value === DURABLE_FORMAT_VERSION;
}
