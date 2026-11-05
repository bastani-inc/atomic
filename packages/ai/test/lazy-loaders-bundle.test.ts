// Adapted from upstream's worker-oauth test (earendil-works/pi 90e20404): OAuth flows and Bedrock must resolve
// inside a bundle that splits at dynamic imports. The bundle registers pi-ai's lazy loaders, so the flows and Bedrock
// load from the bundle's own chunks, never from pi-ai's source files (pi-ai's default variable-specifier imports
// would load them from there, outside the bundle).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { it } from "vitest";

/** A real `bun build` plus a Node child process that loads the AWS SDK. */
const BUNDLE_AND_RUN_TIMEOUT_MS = 120_000;

const packageRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const aiSource = join(packageRoot, "src");
const repositoryRoot = join(packageRoot, "..", "..");

/**
 * Lays out a temporary directory whose module resolution matches pi-ai's own: the bundle's directory sees
 * pi-ai's nested dependencies first, then the workspace root's. The links are returned so cleanup removes them
 * before the directory, never walking into the linked dependencies.
 */
function bundleDirectory(): { root: string; bundleRoot: string; links: string[] } {
	const root = mkdtempSync(join(tmpdir(), "pi-ai-lazy-bundle-"));
	const bundleRoot = join(root, "bundle");
	mkdirSync(bundleRoot);
	const links: string[] = [];
	const link = (target: string, path: string) => {
		symlinkSync(target, path, "junction");
		links.push(path);
	};
	link(join(repositoryRoot, "node_modules"), join(root, "node_modules"));
	const nestedModules = join(packageRoot, "node_modules");
	if (existsSync(nestedModules)) link(nestedModules, join(bundleRoot, "node_modules"));
	return { root, bundleRoot, links };
}

/** An absolute path: Bun's bundler keeps `file:` URL specifiers external instead of bundling them. */
function sourceSpecifier(relativePath: string): string {
	return JSON.stringify(join(aiSource, relativePath));
}

it(
	"a code-split Node bundle resolves stored Radius OAuth credentials and loads Bedrock from its own chunks",
	() => {
		const { root, bundleRoot, links } = bundleDirectory();
		try {
			const entry = join(bundleRoot, "entry.ts");
			writeFileSync(
				entry,
				`
import { registerLazyBedrockProvider } from ${sourceSpecifier("lazy-bedrock-provider.ts")};
import { registerLazyOAuthFlows } from ${sourceSpecifier("lazy-oauth.ts")};
import { bedrockConverseStreamApi } from ${sourceSpecifier("api/bedrock-converse-stream.lazy.ts")};
import { InMemoryCredentialStore } from ${sourceSpecifier("auth/credential-store.ts")};
import { createModels } from ${sourceSpecifier("models.ts")};
import { radiusProvider } from ${sourceSpecifier("providers/radius.ts")};
registerLazyOAuthFlows();
registerLazyBedrockProvider();
globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
const credentials = new InMemoryCredentialStore();
await credentials.modify("radius", async () => ({
	type: "oauth", access: "fixture-token", refresh: "unused", expires: Date.now() + 3600000,
}));
const models = createModels({ credentials });
models.setProvider(radiusProvider({ gateway: "https://radius.example" }));
const auth = await models.getAuth("radius");
// An aborted request: Bedrock's implementation and the AWS SDK load, nothing is sent.
const model = { id: "fixture", name: "fixture", api: "bedrock-converse-stream", provider: "amazon-bedrock",
	baseUrl: "https://bedrock.example", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const bedrock = await bedrockConverseStreamApi().stream(model, { messages: [] }, { signal: AbortSignal.abort() }).result();
console.log(JSON.stringify({ auth, bedrock: bedrock.stopReason }));
process.exit(0);
`,
			);
			const outdir = join(bundleRoot, "out");
			const build = spawnSync(
				"bun",
				[
					"build",
					entry,
					"--target=node",
					"--format=esm",
					"--splitting",
					"--packages=external",
					`--outdir=${outdir}`,
				],
				{ cwd: bundleRoot, encoding: "utf8" },
			);
			assert.equal(build.status, 0, build.stderr);

			const chunks = readdirSync(outdir).filter((file) => file.endsWith(".js"));
			const entryCode = readFileSync(join(outdir, "entry.js"), "utf8");
			const allCode = chunks.map((file) => readFileSync(join(outdir, file), "utf8")).join("\n");
			// The Bedrock implementation and the Radius flow are bundled, but outside the entry chunk.
			for (const marker of ["ConverseStreamCommand", "Sign in with device code"]) {
				assert.ok(allCode.includes(marker), `the bundle contains ${marker}`);
				assert.ok(!entryCode.includes(marker), `${marker} is in a lazy chunk, not the entry chunk`);
			}

			const loadedFile = join(root, "loaded.json");
			const hook = join(root, "hook.mjs");
			writeFileSync(
				hook,
				`
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
const loaded = [];
registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
process.on("exit", () => writeFileSync(${JSON.stringify(loadedFile)}, JSON.stringify(loaded)));
`,
			);
			const run = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, join(outdir, "entry.js")], {
				cwd: bundleRoot,
				encoding: "utf8",
			});
			assert.equal(run.status, 0, run.stderr);
			assert.deepEqual(JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1) ?? ""), {
				auth: { auth: { apiKey: "fixture-token" }, source: "OAuth" },
				bedrock: "aborted",
			});

			const loaded = JSON.parse(readFileSync(loadedFile, "utf8")) as string[];
			// The flow and Bedrock came from the bundle: nothing loaded from pi-ai's sources, the AWS SDK did load.
			assert.deepEqual(
				loaded.filter((url) => url.startsWith(pathToFileURL(aiSource).href)),
				[],
			);
			assert.ok(loaded.some((url) => url.includes("/node_modules/@aws-sdk/client-bedrock-runtime/")));
		} finally {
			for (const path of links) unlinkSync(path);
			rmSync(root, { recursive: true, force: true });
		}
	},
	BUNDLE_AND_RUN_TIMEOUT_MS,
);
