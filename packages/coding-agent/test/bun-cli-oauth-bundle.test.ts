import { readFileSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const entrypoint = realpathSync(fileURLToPath(new URL("../src/bun/cli.ts", import.meta.url)));
const output = join(tmpdir(), `atomic-cli-oauth-${process.pid}.cjs`);

afterEach(() => rmSync(output, { force: true }));

describe("standalone Bun OAuth registration", () => {
	it("statically bundles every interactive OAuth adapter before CLI startup", async () => {
		const build = spawnSync(
			"bun",
			["build", entrypoint, "--target=bun", "--format=cjs", "--external", "mupdf", `--outfile=${output}`],
			{ encoding: "utf8" },
		);
		expect(build.status, build.stderr).toBe(0);
		const bundled = readFileSync(output, "utf8");
		for (const marker of ["registerBundledOAuthFlowLoaders", "githubCopilot", "openaiCodex", "xai", "device_code"]) {
			expect(bundled).toContain(marker);
		}
		const source = readFileSync(entrypoint, "utf8");
		const registerAt = source.indexOf("registerBunOAuthFlows();");
		const startupAt = source.indexOf('import("./register-bedrock.ts")');
		expect(registerAt).toBeGreaterThanOrEqual(0);
		expect(startupAt).toBeGreaterThan(registerAt);
	});
});
