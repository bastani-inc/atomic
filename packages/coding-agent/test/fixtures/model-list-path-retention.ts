import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";

const root = process.argv[2]!;
const provider = "github-copilot";
async function visit(index: number) {
	const dir = join(root, `released-model-cache-${index}`);
	await mkdir(dir);
	await writeFile(join(dir, "models-store.json"), JSON.stringify({ [provider]: { models: [], checkedAt: 1 } }));
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({ [provider]: { type: "api_key", key: "fixture" } }),
		modelsPath: join(dir, "models.json"),
		refreshOnCreate: false,
	});
	await runtime.getAvailable(provider);
}
for (let index = 0; index < 12; index++) await visit(index);
for (let pass = 0; pass < 6; pass++) {
	await Bun.sleep(20);
	Bun.gc(true);
}
const raw = Bun.generateHeapSnapshot("v8");
const snapshot = typeof raw === "string" ? JSON.parse(raw) : raw;
const paths = (snapshot.strings as string[]).filter((value) => /released-model-cache-\d+[\\/]models-store\.json$/u.test(value));
console.log(new Set(paths).size);
