import { describe } from "vitest";
import { postgresSkipReason } from "../helpers/postgres-database.js";

/**
 * Fleet safety (#5072) on PostgreSQL (#4793): the controller's boot holds, live-lease checks and drains, and the worker
 * host's drain fence and drain reads, run as test/unit/workflow-fleet-safety.test.ts runs them on libSQL, each on a
 * PostgreSQL database of its own.
 */
if (postgresSkipReason === undefined) {
	process.env.FLEET_SAFETY_BACKEND = "postgres";
	await import("../unit/workflow-fleet-safety.test.js");
} else describe.skip(`fleet safety on PostgreSQL (skipped: ${postgresSkipReason})`, () => {});
