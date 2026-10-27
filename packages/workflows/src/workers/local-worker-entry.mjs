import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Source checkouts only: published builds replace this file with a bundled worker. Every pool coordinator and worker
// process starts here, so caching jiti's transforms on disk (keyed by source hash) cuts each start from about 6 to
// 2 CPU-seconds.
const loader = createJiti(import.meta.url, { fsCache: true });
const { runLocalWorker } = await loader.import(fileURLToPath(new URL("./local-worker.ts", import.meta.url)));
await runLocalWorker(JSON.parse(process.argv[2]));
