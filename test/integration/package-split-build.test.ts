/**
 * The built package as npm installs it: its entries and the shared files they load, one instance of every module a
 * host and its extensions share, and its assets and source maps from wherever the package is installed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, test } from "vitest";
import { prepareAgentDir } from "../helpers/event-loop-guard-fixture.js";
import { type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import { moduleDir } from "../helpers/runtime.js";
import { removeTestDirectory } from "../helpers/test-directory-removal.js";

const repoRoot = resolve(moduleDir(import.meta.url), "../..");
const packageDir = join(repoRoot, "packages", "coding-agent");
const dist = join(packageDir, "dist");
/** The package's entry files, as `scripts/split-dist.mjs` writes them. */
const ENTRIES = ["cli", "main", "index", "rpc-entry", "core/storage/index", "core/storage/testing"];
// Copying the package and starting it in a terminal is structural work.
const LAYOUT_TIMEOUT_MS = 120_000;
const SESSION_TIMEOUT_MS = 120_000;

let layoutRoot: string | undefined;
afterAll(() => {
	if (layoutRoot) removeTestDirectory(layoutRoot, { retries: 20, retryDelayMs: 50 });
}, LAYOUT_TIMEOUT_MS);

/** The `dist` files an entry loads, statically or when a dynamic import runs, transitively through shared files. */
function loadedFrom(entries: readonly string[]): Set<string> {
	const seen = new Set<string>();
	const pending = entries.map((entry) => `${entry}.js`);
	while (pending.length > 0) {
		const file = pending.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		const source = fs.readFileSync(join(dist, file), "utf8");
		for (const match of source.matchAll(/(?:from|import\()\s*"(\.{1,2}\/[^"]+)"/g)) {
			pending.push(posix.normalize(posix.join(posix.dirname(file), match[1] as string)));
		}
	}
	return seen;
}

/**
 * The package installed at a path with spaces, a non-ASCII letter and URL-reserved characters, beside links to the
 * workspace's other packages: what `npm install` leaves, moved somewhere the build never saw.
 */
function installedLayout(): { readonly nodeModules: string; readonly atomic: string } {
	layoutRoot ??= fs.mkdtempSync(join(os.tmpdir(), "atomic split café #% "));
	const nodeModules = join(layoutRoot, "install", "node_modules");
	const atomic = join(nodeModules, "@bastani", "atomic");
	if (fs.existsSync(atomic)) return { nodeModules, atomic };
	const linkType = process.platform === "win32" ? "junction" : "dir";
	const repoNodeModules = join(repoRoot, "node_modules");
	fs.mkdirSync(nodeModules, { recursive: true });
	for (const name of fs.readdirSync(repoNodeModules)) {
		if (name === ".bin" || name === ".cache") continue;
		const source = join(repoNodeModules, name);
		if (!fs.statSync(source).isDirectory()) continue;
		if (name.startsWith("@")) {
			fs.mkdirSync(join(nodeModules, name), { recursive: true });
			for (const scoped of fs.readdirSync(source)) {
				if (name === "@bastani" && scoped === "atomic") continue;
				fs.symlinkSync(fs.realpathSync(join(source, scoped)), join(nodeModules, name, scoped), linkType);
			}
			continue;
		}
		fs.symlinkSync(fs.realpathSync(source), join(nodeModules, name), linkType);
	}
	fs.mkdirSync(atomic, { recursive: true });
	fs.copyFileSync(join(packageDir, "package.json"), join(atomic, "package.json"));
	fs.cpSync(dist, join(atomic, "dist"), { recursive: true, dereference: true });
	return { nodeModules, atomic };
}

test(
	"the packed package holds its entries, every shared file they load and none of the build's own state",
	() => {
		const npm = process.platform === "win32" ? "npm.cmd" : "npm";
		const packed = spawnSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts", packageDir], {
			cwd: repoRoot,
			encoding: "utf8",
			shell: process.platform === "win32",
			maxBuffer: 64 * 1024 * 1024,
		});
		assert.equal(packed.status, 0, packed.stderr);
		const [{ files }] = JSON.parse(packed.stdout) as [{ files: { path: string }[] }];
		const paths = new Set(files.map((file) => file.path));
		for (const file of loadedFrom(ENTRIES)) assert.ok(paths.has(`dist/${file}`), `dist/${file} is not packed`);
		for (const entry of ENTRIES) assert.ok(paths.has(`dist/${entry}.js.map`), `dist/${entry}.js.map is not packed`);
		assert.ok(paths.has("dist/dist-module-url.js"));
		assert.ok(
			[...paths].every((path) => !path.includes("atomic-split-dist")),
			"the split's build state stays out of the package",
		);
		const manifest = JSON.parse(fs.readFileSync(join(packageDir, "package.json"), "utf8")) as {
			exports: Record<string, Record<string, string>>;
			imports: Record<string, string>;
			bin: Record<string, string>;
		};
		assert.equal(manifest.imports["#dist-module-url"], "./dist/dist-module-url.js");
		for (const target of [
			...Object.values(manifest.exports).flatMap((conditions) => Object.values(conditions)),
			...Object.values(manifest.bin),
		])
			assert.ok(paths.has(posix.normalize(target)), `${target} is not packed`);
	},
	LAYOUT_TIMEOUT_MS,
);

test(
	"a stack thrown in the package names its TypeScript source, also where it is installed",
	() => {
		const { atomic } = installedLayout();
		const probe = spawnSync(
			process.execPath,
			[
				"--enable-source-maps",
				"--input-type=module",
				"-e",
				`const { parseArgs } = await import(${JSON.stringify(pathToFileURL(join(atomic, "dist", "index.js")).href)});
				try { parseArgs(["--session-dir"]); } catch (error) { console.log(error.stack); }`,
			],
			{ encoding: "utf8", timeout: LAYOUT_TIMEOUT_MS },
		);
		assert.equal(probe.status, 0, probe.stderr);
		assert.match(probe.stdout, /src[\\/]cli[\\/]args\.ts:\d+:\d+/, probe.stdout);
	},
	LAYOUT_TIMEOUT_MS,
);

interface IdentityRecord {
	readonly type: "ready" | "error" | "virtual-retired" | "native-retired";
	readonly revision: string;
	readonly checks?: [string, string, boolean][];
	readonly ctxModel?: boolean;
	readonly ctxSession?: boolean;
	readonly error?: string;
}

/**
 * An extension the loader transpiles, importing what Atomic shares with extensions under every name it answers to,
 * and comparing each with the same export imported natively, through Node, from the installed package: one instance
 * each, before and after `/reload`, and a context the SDK's own classes recognise.
 */
const SHARED_EXPORTS: [alias: string, packageName: string, exportName: string][] = [
	["@bastani/atomic", "@bastani/atomic", "ModelRegistry"],
	["@mariozechner/pi-coding-agent", "@bastani/atomic", "SessionManager"],
	["@earendil-works/pi-coding-agent", "@bastani/atomic", "registerExtensionContextRetirementEffect"],
	["@bastani/atomic/storage", "@bastani/atomic/storage", "SessionBlobError"],
	["@sinclair/typebox", "typebox", "Object"],
	["@sinclair/typebox/value", "typebox/value", "Check"],
	["@sinclair/typebox/compile", "typebox/compile", "Compile"],
	["@mariozechner/pi-ai", "@bastani/atomic-ai/compat", "validateToolArguments"],
	["@earendil-works/pi-tui", "@bastani/atomic-tui", "Container"],
	["@earendil-works/pi-agent-core", "@bastani/atomic-agent-core", "Agent"],
];

for (const host of ["in-process", "isolated"] as const) {
	test(
		`an extension sees one instance of the package's shared exports before and after /reload (${host} host)`,
		async () => {
			const { nodeModules, atomic } = installedLayout();
			const root = fs.mkdtempSync(join(layoutRoot as string, `${host}-`));
			const project = join(root, "project");
			const agentDir = join(root, "agent");
			const home = join(root, "home");
			const record = join(root, "record.jsonl");
			for (const directory of [project, agentDir, home]) fs.mkdirSync(directory, { recursive: true });
			prepareAgentDir(agentDir, "http://127.0.0.1:9");
			fs.symlinkSync(nodeModules, join(project, "node_modules"), process.platform === "win32" ? "junction" : "dir");
			fs.writeFileSync(join(project, "native.cjs"), "exports.load = (name) => import(name);\n");
			fs.writeFileSync(join(project, "revision.ts"), 'export const revision = "first";\n');
			const extension = join(project, "extension.ts");
			fs.writeFileSync(
				extension,
				[
					'import { appendFileSync } from "node:fs";',
					'import { createRequire } from "node:module";',
					'import { revision } from "./revision.ts";',
					...SHARED_EXPORTS.map(([alias], index) => `import * as shared${index} from ${JSON.stringify(alias)};`),
					`const native = createRequire(${JSON.stringify(join(project, "index.cjs"))})("./native.cjs");`,
					`const log = (type, data = {}) => appendFileSync(${JSON.stringify(record)}, JSON.stringify({ type, revision, ...data }) + "\\n");`,
					`const pairs = ${JSON.stringify(SHARED_EXPORTS)};`,
					`const viaLoader = [${SHARED_EXPORTS.map((_, index) => `shared${index}`).join(", ")}];`,
					"export default function (pi) {",
					'	pi.on("session_start", async (_event, ctx) => {',
					"		try {",
					"			const checks = [];",
					"			for (const [index, [alias, packageName, name]] of pairs.entries()) {",
					"				const direct = await native.load(packageName);",
					"				checks.push([alias, typeof viaLoader[index][name], viaLoader[index][name] === direct[name]]);",
					"			}",
					'			const sdk = await native.load("@bastani/atomic");',
					'			shared0.registerExtensionContextRetirementEffect(ctx, () => log("virtual-retired"));',
					'			sdk.registerExtensionContextRetirementEffect(ctx, () => log("native-retired"));',
					'			log("ready", { checks, ctxModel: ctx.modelRegistry instanceof sdk.ModelRegistry, ctxSession: ctx.sessionManager instanceof sdk.SessionManager });',
					"		} catch (error) {",
					'			log("error", { error: String(error && error.stack || error) });',
					"		}",
					"	});",
					"}",
				].join("\n"),
			);
			const read = (): IdentityRecord[] =>
				fs.existsSync(record)
					? fs
							.readFileSync(record, "utf8")
							.trim()
							.split("\n")
							.filter(Boolean)
							.map((line) => JSON.parse(line) as IdentityRecord)
					: [];
			const env: Record<string, string> = {
				PATH: process.env.PATH ?? "",
				HOME: home,
				USERPROFILE: home,
				ATOMIC_CODING_AGENT_DIR: agentDir,
				ATOMIC_OFFLINE: "1",
				ATOMIC_SKIP_VERSION_CHECK: "1",
				ATOMIC_TELEMETRY: "0",
				ATOMIC_INTERCOM_JOIN_AT_STARTUP: "0",
				TERM: "xterm-256color",
				CI: "0",
			};
			for (const name of ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR"])
				if (process.env[name]) env[name] = process.env[name] as string;
			let program: PtyProgram | undefined;
			try {
				program = startPtyProgram({
					executable: process.execPath,
					args: [
						join(atomic, "dist", "cli.js"),
						"--offline",
						"--no-mcp",
						host === "in-process" ? "--no-approve" : "--approve",
						"-e",
						extension,
					],
					cwd: project,
					env,
					cols: 120,
					rows: 40,
					timeoutMs: SESSION_TIMEOUT_MS,
				});
				const started = (revision: string) => (screen: string) =>
					screen.includes("❯") && read().some((entry) => entry.revision === revision);
				await program.waitForScreen(started("first"), SESSION_TIMEOUT_MS / 2, "the first session start");
				fs.writeFileSync(join(project, "revision.ts"), 'export const revision = "second";\n');
				program.write("/reload");
				await program.waitForScreen(
					(screen) => screen.includes("/reload"),
					SESSION_TIMEOUT_MS / 4,
					"/reload typed",
				);
				program.write("\r");
				await program.waitForScreen(started("second"), SESSION_TIMEOUT_MS / 2, "the reloaded session start");
				program.write("/quit");
				await program.waitForScreen((screen) => screen.includes("/quit"), SESSION_TIMEOUT_MS / 4, "/quit typed");
				program.write("\r");
				const exited = await program.exited;
				assert.equal(exited.exitCode, 0, program.screen());
			} finally {
				program?.kill();
			}
			const records = read();
			assert.deepEqual(
				records.filter((entry) => entry.type === "error"),
				[],
			);
			const ready = records.filter((entry) => entry.type === "ready");
			assert.deepEqual(
				ready.map((entry) => entry.revision),
				["first", "second"],
			);
			for (const entry of ready) {
				assert.equal(entry.ctxModel, true, "the context's model registry is the SDK's ModelRegistry");
				assert.equal(entry.ctxSession, true, "the context's session manager is the SDK's SessionManager");
				for (const [alias, type, same] of entry.checks ?? []) {
					assert.notEqual(type, "undefined", `${alias} is missing`);
					assert.equal(same, true, `${alias} is another instance than Node's`);
				}
			}
			// Each generation's context retires once, at /reload and at quit, through both registrations.
			assert.equal(records.filter((entry) => entry.type === "virtual-retired").length, 2);
			assert.equal(records.filter((entry) => entry.type === "native-retired").length, 2);
		},
		SESSION_TIMEOUT_MS + LAYOUT_TIMEOUT_MS,
	);
}
