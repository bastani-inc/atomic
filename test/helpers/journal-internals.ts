import assert from "node:assert/strict";
import { synchronousJournal } from "../../packages/workflows/src/durable/journal/internal.js";
import type { RunJournal } from "../../packages/workflows/src/durable/journal/types.js";

export function journalInternals(journal: RunJournal) {
	const internal = synchronousJournal(journal);
	assert.ok(internal);
	return internal;
}
