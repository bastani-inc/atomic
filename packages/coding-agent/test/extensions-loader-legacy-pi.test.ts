import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";

it("loads legacy pi coding-agent imports into the running host", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-legacy-pi-"));
	try {
		const extensionPath = path.join(directory, "legacy.ts");
		fs.writeFileSync(
			extensionPath,
			`
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir as legacyDir } from "@mariozechner/pi-coding-agent";
import { getAgentDir as currentDir } from "@earendil-works/pi-coding-agent";
import { getAgentDir as hostDir } from "@bastani/atomic";
if (legacyDir !== currentDir || legacyDir !== hostDir) throw new Error("legacy import lost host identity");
export default function (pi: ExtensionAPI) {
  pi.registerCommand("legacy-probe", { description: legacyDir(), handler: async () => {} });
}
`,
		);
		const result = await loadExtensions([extensionPath], directory);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.commands.has("legacy-probe")).toBe(true);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
}, 120_000);
