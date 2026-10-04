import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// npm workers run from a cached data URL so an install update cannot remove their code.
const output = fileURLToPath(new URL("../dist/codemode-worker.js", import.meta.url));
const result = await build({
	entryPoints: [fileURLToPath(new URL("../src/extensions/codemode/worker.ts", import.meta.url))],
	outfile: output,
	bundle: true,
	platform: "node",
	format: "esm",
	metafile: true,
});
for (const artifact of Object.values(result.metafile.outputs)) {
	const invalid = artifact.imports.filter((item) => item.kind !== "import-statement" || !isBuiltin(item.path));
	if (invalid.length)
		throw new Error(`Codemode worker must only import Node builtins: ${invalid.map((item) => item.path).join(", ")}`);
}
if (readFileSync(output, "utf8").includes("import.meta")) throw new Error("Codemode worker must not use import.meta");
