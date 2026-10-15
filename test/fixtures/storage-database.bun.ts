import { describe, test } from "bun:test";
import { registerSqliteDatabaseConformance } from "../../packages/coding-agent/src/core/storage/testing.js";
import { withNodeSqliteDatabase } from "../helpers/storage-database.js";

registerSqliteDatabaseConformance({ describe, it: test }, "node SQLite on Bun", withNodeSqliteDatabase);
