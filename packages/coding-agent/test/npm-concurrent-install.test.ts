import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "vitest";
import { bunExecutable, npmSpawnPrefix, readStreamText, spawnProcess } from "../../../test/helpers/runtime.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

const PACKAGES = ["pkg-a", "pkg-b", "pkg-c", "pkg-d"];
/** Each case runs `atomic install` in several Bun processes, each of which runs a real npm install. */
const CONCURRENT_INSTALLS_TIMEOUT_MS = 180_000;

describe("concurrent npm package installs (#4966)", () => {
	let tempDir: string;
	let agentDir: string;
	let server: Server;
	let childEnv: Record<string, string | undefined>;

	async function install(sources: string[]): Promise<void> {
		const cli = JSON.stringify(fileURLToPath(new URL("../src/package-manager-cli.ts", import.meta.url)));
		const children = sources.map((source) =>
			spawnProcess(
				[
					bunExecutable(),
					"--eval",
					`
					import { handlePackageCommand } from ${cli};
					await handlePackageCommand(["install", ${JSON.stringify(source)}]);
					if (process.exitCode) process.exit(process.exitCode);
					`,
				],
				{ stdout: "pipe", stderr: "pipe", env: childEnv },
			),
		);
		await Promise.all(
			children.map(async (child) => {
				const [stdout, stderr, code] = await Promise.all([
					readStreamText(child.stdout),
					readStreamText(child.stderr),
					child.exited,
				]);
				assert.equal(code, 0, `${stdout}\n${stderr}`);
			}),
		);
	}

	beforeEach(async () => {
		tempDir = join(tmpdir(), `atomic-npm-concurrent-${process.pid}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });

		// A local registry serving a packument and an `npm pack` tarball for each package.
		const tarballs = new Map<string, Buffer>();
		for (const name of PACKAGES) {
			const packageDir = join(tempDir, "sources", name);
			mkdirSync(packageDir, { recursive: true });
			writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
			writeFileSync(join(packageDir, "index.js"), "module.exports = {};\n");
			const [prefix, ...prefixArgs] = npmSpawnPrefix();
			const file = execFileSync(prefix!, [...prefixArgs, "pack", "--silent", "--pack-destination", packageDir], {
				cwd: packageDir,
				encoding: "utf-8",
			}).trim();
			tarballs.set(name, readFileSync(join(packageDir, file)));
		}
		server = createServer((request, response) => {
			const url = request.url ?? "";
			const [, name, tarball] = /^\/([^/]+)(\/-\/.+\.tgz)?$/.exec(url) ?? [];
			const data = name ? tarballs.get(decodeURIComponent(name)) : undefined;
			if (!name || !data) {
				response.writeHead(404).end();
				return;
			}
			if (tarball) {
				response.writeHead(200, { "content-type": "application/octet-stream" }).end(data);
				return;
			}
			const { port } = server.address() as AddressInfo;
			const packument = {
				name,
				"dist-tags": { latest: "1.0.0" },
				versions: {
					"1.0.0": {
						name,
						version: "1.0.0",
						dist: {
							tarball: `http://127.0.0.1:${port}/${name}/-/${name}-1.0.0.tgz`,
							shasum: createHash("sha1").update(data).digest("hex"),
							integrity: `sha512-${createHash("sha512").update(data).digest("base64")}`,
						},
					},
				},
			};
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(packument));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		childEnv = {
			...process.env,
			[ENV_AGENT_DIR]: agentDir,
			npm_config_registry: `http://127.0.0.1:${port}/`,
			npm_config_cache: join(tempDir, "npm-cache"),
			npm_config_userconfig: join(tempDir, "npmrc"),
		};
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(tempDir, { recursive: true, force: true });
	});

	it(
		"keeps every package from concurrent installs, and a later install keeps them (#4966)",
		async () => {
			await install(["npm:pkg-a", "npm:pkg-b", "npm:pkg-c"]);
			await install(["npm:pkg-d"]);

			const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as { packages?: string[] };
			assert.deepEqual(
				[...(settings.packages ?? [])].sort(),
				PACKAGES.map((name) => `npm:${name}`),
			);
			const manifest = JSON.parse(readFileSync(join(agentDir, "npm", "package.json"), "utf-8")) as {
				dependencies?: Record<string, string>;
			};
			assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), PACKAGES);
			for (const name of PACKAGES) {
				assert.equal(existsSync(join(agentDir, "npm", "node_modules", name, "package.json")), true, name);
			}
		},
		CONCURRENT_INSTALLS_TIMEOUT_MS,
	);
});
