import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

const packageDir = path.resolve(import.meta.dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-bundled-legacy-pi-"));
const app = path.join(root, "app.js");

beforeAll(() => {
	const build = spawnSync(
		"bun",
		[
			"build",
			"src/bun/cli.ts",
			"--target=bun",
			"--external",
			"mupdf",
			"--define",
			'process.env.ATOMIC_BUNDLED_BUILD="1"',
			"--outfile",
			app,
		],
		{ cwd: packageDir, encoding: "utf8", timeout: 60_000 },
	);
	expect(build.status, build.stderr).toBe(0);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function run(name: string, source: string, mode: "print" | "rpc" | "interactive" = "print", explicit = false) {
	const home = path.join(root, name);
	const extensions = path.join(home, ".pi", "agent", "extensions");
	fs.mkdirSync(extensions, { recursive: true });
	fs.writeFileSync(path.join(extensions, "legacy.ts"), source);
	const child = spawn(
		"bun",
		[
			app,
			"--offline",
			"--approve",
			"--no-session",
			...(mode === "print" ? ["-p", "hi"] : ["--mode", "rpc"]),
			...(explicit ? ["--extension", path.join(extensions, "legacy.ts")] : []),
		],
		{
			cwd: home,
			env: {
				HOME: home,
				USERPROFILE: home,
				PATH: process.env.PATH,
				TERM: "dumb",
				NO_COLOR: "1",
				ATOMIC_PACKAGE_DIR: packageDir,
				ATOMIC_SKIP_VERSION_CHECK: "1",
				...(mode === "interactive" ? { ATOMIC_INTERACTIVE_ENGINE_CHILD: "1" } : {}),
			},
			stdio: "pipe",
		},
	);
	return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`CLI did not finish\n${stderr}\n${stdout}`));
		}, 25_000);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (text) => {
			stderr += text;
		});
		child.stdout.on("data", (text) => {
			stdout += text;
			if (
				stdout.split("\n").some((line) => {
					try {
						return JSON.parse(line).id === "resources";
					} catch {
						return false;
					}
				})
			)
				child.stdin.end();
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({ status, stdout, stderr });
		});
		child.stdin.on("error", () => {});
		if (mode === "print") child.stdin.end();
		else child.stdin.write('{"id":"probe","type":"get_state"}\n{"id":"resources","type":"get_available_models"}\n');
	});
}

it("loads an auto-discovered legacy pi extension through the bundled app without installed pi packages", async () => {
	const result = await run(
		"legacy",
		`import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir as legacy } from "@mariozechner/pi-coding-agent";
import { getAgentDir as current } from "@earendil-works/pi-coding-agent";
export default function(pi: ExtensionAPI) {
  if (legacy !== current) throw new Error("host identity mismatch");
  console.error("LEGACY_EXTENSION_LOADED");
}`,
	);
	expect(result.stderr).toContain("LEGACY_EXTENSION_LOADED");
	expect(result.stderr).not.toContain("Failed to load extension");
	expect(result.stderr).not.toContain("missing sourcemaps");
});

it("keeps a broken legacy extension fatal and named in print mode", async () => {
	const result = await run(
		"broken-print",
		'throw new Error("legacy dependency unavailable"); export default () => {};',
	);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain('Failed to load extension "');
	expect(result.stderr).toContain("legacy.ts");
	expect(result.stderr).toContain("legacy dependency unavailable");
	expect(result.stderr).not.toContain("missing sourcemaps");
});

it("skips a broken legacy extension when RPC is serving the interactive host", async () => {
	const result = await run(
		"broken-interactive",
		'throw new Error("legacy dependency unavailable"); export default () => {};',
		"interactive",
	);
	expect(result.stderr).toContain("legacy.ts");
	expect(result.stderr).toContain("legacy dependency unavailable");
	expect(result.stdout).toContain('"id":"probe"');
	expect(result.stdout).toContain('"success":true');
	expect(result.stderr).not.toContain("missing sourcemaps");
});

it("keeps a broken legacy extension fatal and named in standalone RPC mode", async () => {
	const result = await run(
		"broken-rpc",
		'throw new Error("legacy dependency unavailable"); export default () => {};',
		"rpc",
	);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain('Failed to load extension "');
	expect(result.stderr).toContain("legacy.ts");
	expect(result.stderr).toContain("legacy dependency unavailable");
	expect(result.stderr).not.toContain("missing sourcemaps");
});

it("completes deferred interactive startup with a named diagnostic for a broken explicit extension", async () => {
	const result = await run(
		"broken-deferred",
		'throw new Error("legacy dependency unavailable"); export default () => {};',
		"interactive",
		true,
	);
	expect(result.stdout).toContain('"type":"extension_error"');
	expect(result.stdout).toContain("legacy.ts");
	expect(result.stdout).toContain("legacy dependency unavailable");
	const response = result.stdout
		.split("\n")
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return undefined;
			}
		})
		.find((event) => event?.id === "resources");
	expect(response, result.stderr).toMatchObject({ success: true });
	expect(result.stderr).not.toContain("missing sourcemaps");
});
