// Opens a file-backed node-sqlite connection, runs a statement, closes it, and returns: the process then exits once
// nothing it started keeps it alive. Prints how long the work took, so the test can tell that from the exit.
import { createJiti } from "jiti";

const [path] = process.argv.slice(2);
const jiti = createJiti(import.meta.url);
const { openNodeSqliteDatabase } = await jiti.import("../../packages/coding-agent/src/core/storage/node-sqlite.ts");
const started = performance.now();
const database = await openNodeSqliteDatabase(path);
await database.run("CREATE TABLE t(v)");
await database.close();
process.stdout.write(`closed after ${Math.round(performance.now() - started)} ms\n`);
