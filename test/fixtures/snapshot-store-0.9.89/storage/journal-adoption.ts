// Not vendored: see ../README.md. 0.9.89's blob store imports this module only to upgrade a run journal at schema
// version 1 when it writes a chunked blob, which this version's upgrade does the same way.
export { upgradeRunJournalSchema } from "../../../../packages/coding-agent/src/core/storage/journal-adoption.ts";
