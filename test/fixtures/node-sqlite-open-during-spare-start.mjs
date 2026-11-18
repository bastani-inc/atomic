// Opens a second database straight after the first, so the second open takes the thread started ahead of it while
// that thread is still starting, with nothing else keeping the process alive. Prints "opened" once both are open.
import { createJiti } from "jiti";

const [first, second] = process.argv.slice(2);
const jiti = createJiti(import.meta.url);
const { openNodeSqliteDatabase } = await jiti.import("../../packages/coding-agent/src/core/storage/node-sqlite.ts");
const a = await openNodeSqliteDatabase(first);
const b = await openNodeSqliteDatabase(second);
await b.run("CREATE TABLE t(v)");
process.stdout.write("opened\n");
await a.close();
await b.close();
