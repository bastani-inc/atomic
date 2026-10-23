import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const loader = createJiti(import.meta.url, { fsCache: false });
const { runLocalWorker } = await loader.import(fileURLToPath(new URL("./local-worker.ts", import.meta.url)));
await runLocalWorker(JSON.parse(process.argv[2]));
