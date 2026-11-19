import { fileURLToPath } from "node:url";
import { withWorkflowTranspileCache, useCliRuntimeStorage } from "@bastani/atomic/runtime-storage";
import { createJiti } from "jiti";

// Source checkouts only: published builds replace this file with a bundled worker. Every pool coordinator and worker
// process starts here, so caching jiti's transforms on disk (keyed by source hash) cuts each start from about 6 to
// 2 CPU-seconds.
useCliRuntimeStorage();
const loader = withWorkflowTranspileCache((fsCache) => createJiti(import.meta.url, { fsCache }), false);
const { runLocalWorker } = await loader.import(fileURLToPath(new URL("./local-worker.ts", import.meta.url)));
await runLocalWorker(JSON.parse(process.argv[2]));
