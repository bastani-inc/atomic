import { createHash } from "node:crypto";

/**
 * Deterministic run/stage id for fixtures.
 *
 * Resolvers now accept only a full 36-character UUID, so a fixture id like
 * `"run-1"` is rejected as malformed before any lookup happens. Deriving the id
 * from a seed keeps each fixture's intent readable at the call site
 * (`testRunId("terminal-send-race")`) while producing a value the resolver
 * accepts, and keeps it stable across runs so failures stay reproducible and
 * snapshots stay comparable.
 *
 * Distinct seeds give distinct ids; the same seed always gives the same id, so
 * a parent and child fixture can be related on purpose rather than by accident.
 */
export function testRunId(seed: string): string {
	const hex = createHash("sha256").update(seed).digest("hex");
	// Pin the version and variant nibbles so the value is a well-formed v4-shaped
	// UUID rather than merely 32 hex characters wearing dashes.
	const version = `4${hex.slice(13, 16)}`;
	const variant = `${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`;
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}-${variant}-${hex.slice(20, 32)}`;
}
