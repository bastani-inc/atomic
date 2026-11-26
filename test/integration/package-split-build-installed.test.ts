/**
 * The installed split package at runtime: source maps, bundled dependencies and licenses, highlight.js extensibility,
 * bundled document converters, extension shared-export identity across `/reload`, and in-place package replacement.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";
import { afterAll, test, vi } from "vitest";
import { prepareAgentDir } from "../helpers/event-loop-guard-fixture.js";
import { type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import { RENAME_RETRY_SYNC_MODULE_PATH, renameWithRetry } from "../helpers/rename-retry.js";
import { bunExecutable } from "../helpers/runtime.js";
import {
	compiledPackage,
	copyTree,
	createInstalledLayoutScope,
	type InstalledLayout,
	LAYOUT_TIMEOUT_MS,
	SESSION_TIMEOUT_MS,
} from "./package-split-build-helpers.js";

const layoutScope = createInstalledLayoutScope();
const { installedLayout } = layoutScope;

afterAll(() => {
	layoutScope.cleanup();
}, LAYOUT_TIMEOUT_MS);

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

test(
	"the dependencies bundled into the shared files load from there, and their licenses ship beside them",
	() => {
		const { atomic } = installedLayout();
		const notices = fs.readFileSync(join(atomic, "dist", "THIRD_PARTY_NOTICES.md"), "utf8");
		const inlined = [...notices.matchAll(/^## (\S+) \S+$/gm)].map((match) => match[1] as string);
		assert.ok(inlined.includes("yaml") && inlined.includes("semver"), notices.slice(0, 400));
		// Each package's own license text, not only the name of its license.
		for (const section of notices.split(/^## /m).slice(1)) {
			const text = section.slice(section.indexOf("\n")).trim();
			assert.doesNotMatch(text, /^License: \S+$/, section.slice(0, 200));
			assert.match(text, /permission|copyright|licen[sc]e/i, section.slice(0, 200));
		}
		const probe = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { registerHooks } from "node:module";
				const packages = new Set();
				registerHooks({ load(url, context, next) {
					const match = /\\/node_modules\\/((?:@[^/]+\\/)?[^/]+)\\//.exec(decodeURIComponent(url).replaceAll("\\\\", "/"));
					if (match) packages.add(match[1]);
					return next(url, context);
				} });
				await import(${JSON.stringify(pathToFileURL(join(atomic, "dist", "main.js")).href)});
				console.log(JSON.stringify([...packages]));`,
			],
			{ encoding: "utf8", timeout: LAYOUT_TIMEOUT_MS },
		);
		assert.equal(probe.status, 0, probe.stderr);
		const loaded = JSON.parse(probe.stdout.trim().split("\n").at(-1) ?? "[]") as string[];
		// A dependency that stays external still loads from node_modules, as the probe sees.
		assert.ok(loaded.includes("chalk"), loaded.join(", "));
		assert.deepEqual(
			loaded.filter((name) => inlined.includes(name)),
			[],
		);
	},
	LAYOUT_TIMEOUT_MS,
);

// highlight.js stays a package of its own: a language or plugin an SDK app registers in the installed highlight.js
// reaches Atomic's highlightCode, as before the split build.
test(
	"a language an SDK app registers in the installed highlight.js reaches highlightCode",
	() => {
		const { atomic } = installedLayout();
		const probe = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { createRequire } from "node:module";
				const hljs = createRequire(${JSON.stringify(join(atomic, "package.json"))})("highlight.js");
				hljs.registerLanguage("atomic-probe", () => ({ contains: [{ className: "keyword", begin: /\\bprobekw\\b/ }] }));
				const sdk = await import(${JSON.stringify(pathToFileURL(join(atomic, "dist", "index.js")).href)});
				sdk.initTheme("dark");
				console.log(JSON.stringify(sdk.highlightCode("probekw plain", "atomic-probe")));`,
			],
			{ encoding: "utf8", timeout: LAYOUT_TIMEOUT_MS },
		);
		assert.equal(probe.status, 0, probe.stderr);
		const [line] = JSON.parse(probe.stdout.trim().split("\n").at(-1) ?? "[]") as string[];
		// The keyword the registered grammar finds is colored on its own.
		assert.match(line ?? "", /probekw\u001b\[39m plain/, JSON.stringify(line));
	},
	LAYOUT_TIMEOUT_MS,
);

/** A one-page PDF drawing `content` with `fonts` (resource name to font dictionary), written by hand. */
function pdfWith(content: string, fonts: Record<string, string>): string {
	const objects: string[] = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
	];
	const fontRefs: string[] = [];
	for (const [name, dictionary] of Object.entries(fonts)) {
		objects.push(dictionary);
		fontRefs.push(`/${name} ${objects.length} 0 R`);
	}
	objects[2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << ${fontRefs.join(" ")} >> >> >>`;
	let pdf = "%PDF-1.4\n";
	const offsets = objects.map((object, index) => {
		const offset = pdf.length;
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
		return offset;
	});
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

const HELVETICA = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

/** A one-page PDF whose page says `text`. */
function onePagePdf(text: string): string {
	return pdfWith(`BT /F1 18 Tf 72 700 Td (${text}) Tj ET`, { F1: HELVETICA });
}

/** A DOCX whose document body is `body`, written by hand. */
async function docxWith(body: string): Promise<Uint8Array> {
	const zip = new JSZip();
	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
	);
	zip.file(
		"_rels/.rels",
		`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
	);
	zip.file(
		"word/document.xml",
		`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
	);
	return zip.generateAsync({ type: "uint8array" });
}

/**
 * Documents and the text a read gives for each. The last four need the converter's dependencies at the versions a
 * fresh install resolves (MuPDF 1.28.6 keeps the text state across a TJ array and maps a subset Symbol font; mammoth
 * 1.13 reads custom XML and moved paragraphs): the bundle must not fall behind them.
 */
const DOCUMENTS: { name: string; content: () => string | Promise<Uint8Array>; texts: string[] }[] = [
	{
		name: "sample.docx",
		content: () => docxWith("<w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p>"),
		texts: ["Hello DOCX"],
	},
	{ name: "sample.pdf", content: () => onePagePdf("Hello PDF"), texts: ["Hello PDF"] },
	{
		name: "text-state.pdf",
		content: () =>
			pdfWith(
				"BT /F1 18 Tf 72 700 Td [(Hello) -200 2 Tc (World) 0 Tc (Again)] TJ ET BT /F1 18 Tf 72 650 Td (Second line) Tj ET",
				{ F1: HELVETICA },
			),
		texts: ["Hello WorldAgain", "Second line"],
	},
	{
		name: "subset-symbol.pdf",
		content: () =>
			pdfWith("BT /F1 18 Tf 72 700 Td (abgd) Tj ET BT /F2 18 Tf 72 650 Td (Plain text) Tj ET", {
				F1: "<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+Symbol >>",
				F2: HELVETICA,
			}),
		texts: ["αβγδ", "Plain text"],
	},
	{
		name: "custom-xml.docx",
		content: () =>
			docxWith(
				'<w:p><w:r><w:t>Before</w:t></w:r></w:p><w:customXml w:element="clause"><w:p><w:r><w:t>Inside custom XML block</w:t></w:r></w:p></w:customXml><w:p><w:customXml w:element="name"><w:r><w:t>inline custom</w:t></w:r></w:customXml><w:r><w:t> after</w:t></w:r></w:p>',
			),
		texts: ["Before", "Inside custom XML block", "inline custom after"],
	},
	{
		name: "moved.docx",
		content: () =>
			docxWith(
				'<w:p><w:r><w:t>Kept</w:t></w:r></w:p><w:p><w:moveTo w:id="1" w:author="a"><w:r><w:t>Moved paragraph text</w:t></w:r></w:moveTo></w:p>',
			),
		texts: ["Kept", "Moved paragraph text"],
	},
];

test(
	"documents convert with the document converter bundled into the shared files, loading only mupdf from node_modules",
	async () => {
		const { atomic } = installedLayout();
		const documents = fs.mkdtempSync(join(layoutScope.layoutRoot() ?? os.tmpdir(), "documents "));
		for (const { name, content } of DOCUMENTS) fs.writeFileSync(join(documents, name), await content());
		const probeFile = join(documents, "probe.mjs");
		fs.writeFileSync(
			probeFile,
			`const packages = new Set();
			if (!process.versions.bun) {
				const { registerHooks } = await import("node:module");
				registerHooks({ load(url, context, next) {
					const match = /\\/node_modules\\/((?:@[^/]+\\/)?[^/]+)\\//.exec(decodeURIComponent(url).replaceAll("\\\\", "/"));
					if (match) packages.add(match[1]);
					return next(url, context);
				} });
			}
			const { createReadToolDefinition } = await import(${JSON.stringify(pathToFileURL(join(atomic, "dist", "index.js")).href)});
			const before = new Set(packages);
			const read = createReadToolDefinition(${JSON.stringify(documents)});
			const text = [];
			for (const path of ${JSON.stringify(DOCUMENTS.map(({ name }) => name))}) {
				const result = await read.execute("read", { path }, undefined, undefined, {});
				text.push(result.content.map((item) => item.text ?? "").join("\\n"));
			}
			console.log(JSON.stringify({ text, loaded: [...packages].filter((name) => !before.has(name)) }));`,
		);
		for (const runtime of [process.execPath, bunExecutable()]) {
			const probe = spawnSync(runtime, [probeFile], { encoding: "utf8", timeout: LAYOUT_TIMEOUT_MS });
			assert.equal(probe.status, 0, `${runtime}: ${probe.stderr}`);
			const { text, loaded } = JSON.parse(probe.stdout.trim().split("\n").at(-1) ?? "{}") as {
				text: string[];
				loaded: string[];
			};
			for (const [index, { name, texts }] of DOCUMENTS.entries()) {
				for (const expected of texts)
					assert.ok(text[index]?.includes(expected), `${runtime} ${name}: ${text[index]}`);
			}
			// Node reports what loads from node_modules; Bun has no load hooks.
			if (runtime === process.execPath) assert.deepEqual(loaded, ["mupdf"]);
		}
	},
	LAYOUT_TIMEOUT_MS,
);

test(
	"a session whose document converter an update removed while it ran asks for a restart when it reads a document",
	() => {
		const { atomic } = installedLayout("updated under a running session");
		const shared = join(atomic, "dist", "_shared");
		const converter = fs
			.readdirSync(shared)
			.filter((name) => name.endsWith(".js"))
			.filter((name) =>
				(JSON.parse(fs.readFileSync(join(shared, `${name}.map`), "utf8")) as { sources: string[] }).sources.some(
					(source) => source.endsWith("/markit-ai/dist/markit.js"),
				),
			);
		assert.equal(converter.length, 1, converter.join(", "));
		const converterFile = join(shared, converter[0] as string);
		const manifestFile = join(atomic, "package.json");
		const manifest = fs.readFileSync(manifestFile, "utf8");
		const documents = fs.mkdtempSync(join(layoutScope.layoutRoot() ?? os.tmpdir(), "documents "));
		fs.writeFileSync(join(documents, "sample.pdf"), onePagePdf("Hello PDF"));
		fs.writeFileSync(join(documents, "notes.txt"), "plain text still reads");
		// What an in-place update does to a running session: the session has loaded Atomic, then the package's files are
		// replaced, the converter's file is not among them, and the package names a new version; or, without the update,
		// only the file is gone.
		const probe = (updated: boolean) => `import { writeFileSync } from "node:fs";
			import { createRequire } from "node:module";
			const { renameSyncWithRetry } = createRequire(import.meta.url)(${JSON.stringify(RENAME_RETRY_SYNC_MODULE_PATH)});
			const { createReadToolDefinition } = await import(${JSON.stringify(pathToFileURL(join(atomic, "dist", "index.js")).href)});
			const read = createReadToolDefinition(${JSON.stringify(documents)});
			renameSyncWithRetry(${JSON.stringify(converterFile)}, ${JSON.stringify(`${converterFile}.gone`)});
			${updated ? `writeFileSync(${JSON.stringify(manifestFile)}, ${JSON.stringify(manifest.replace(/"version": "[^"]+"/, '"version": "0.0.1"'))});` : ""}
			const text = [];
			try {
				for (const path of ["sample.pdf", "sample.pdf", "notes.txt"]) {
					const result = await read.execute("read", { path }, undefined, undefined, {});
					text.push(result.content.map((item) => item.text ?? "").join("\\n"));
				}
			} finally {
				renameSyncWithRetry(${JSON.stringify(`${converterFile}.gone`)}, ${JSON.stringify(converterFile)});
				writeFileSync(${JSON.stringify(manifestFile)}, ${JSON.stringify(manifest)});
			}
			console.log(JSON.stringify(text));`;
		const restart =
			"atomic was updated to 0.0.1 while this session was running; restart it to keep using document conversion.";
		for (const updated of [true, false]) {
			const probeFile = join(documents, `probe-${updated ? "updated" : "unchanged"}.mjs`);
			fs.writeFileSync(probeFile, probe(updated));
			for (const runtime of [process.execPath, bunExecutable()]) {
				const result = spawnSync(runtime, [probeFile], { encoding: "utf8", timeout: LAYOUT_TIMEOUT_MS });
				assert.equal(result.status, 0, `${runtime}: ${result.stderr}`);
				const [first, second, plain] = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "[]") as string[];
				for (const text of [first, second]) {
					if (updated) assert.ok(text?.includes(restart), `${runtime}: ${text}`);
					else assert.ok(!text?.includes("restart"), `${runtime}: ${text}`);
				}
				assert.match(plain ?? "", /plain text still reads/, runtime);
			}
		}
	},
	LAYOUT_TIMEOUT_MS,
);

test(
	"starting Atomic loads none of the document converter's modules",
	() => {
		const { atomic } = installedLayout();
		const probe = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { registerHooks } from "node:module";
				const shared = new Set();
				registerHooks({ load(url, context, next) { if (url.includes("/_shared/")) shared.add(url); return next(url, context); } });
				await import(${JSON.stringify(pathToFileURL(join(atomic, "dist", "main.js")).href)});
				console.log(JSON.stringify([...shared]));`,
			],
			{ encoding: "utf8", timeout: LAYOUT_TIMEOUT_MS },
		);
		assert.equal(probe.status, 0, probe.stderr);
		const loaded = JSON.parse(probe.stdout.trim().split("\n").at(-1) ?? "[]") as string[];
		assert.ok(loaded.length > 0, "the CLI's modules load from shared files");
		for (const url of loaded) {
			const file = fileURLToPath(url);
			const map = JSON.parse(fs.readFileSync(`${file}.map`, "utf8")) as { sources: string[] };
			assert.deepEqual(
				map.sources.filter((source) => source.includes("/markit-ai/")),
				[],
				`${relative(atomic, file)} holds the document converter`,
			);
		}
		const notices = fs.readFileSync(join(atomic, "dist", "THIRD_PARTY_NOTICES.md"), "utf8");
		assert.match(notices, /^## markit-ai \S+$/m);
		// isarray states its license only in its README.
		assert.match(notices, /^## isarray \S+\n\n[\s\S]*?Permission is hereby granted/m);
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
	// Atomic's own copy of TypeBox, which the SDK re-exports: every TypeBox name an extension imports reaches it.
	["typebox", "@bastani/atomic/typebox", "Object"],
	["typebox/format", "@bastani/atomic/typebox/format", "Format"],
	["@sinclair/typebox", "@bastani/atomic/typebox", "Object"],
	["@sinclair/typebox/value", "@bastani/atomic/typebox/value", "Check"],
	["@sinclair/typebox/compile", "@bastani/atomic/typebox/compile", "Compile"],
	["@mariozechner/pi-ai", "@bastani/atomic-ai/compat", "validateToolArguments"],
	["@earendil-works/pi-tui", "@bastani/atomic-tui", "Container"],
	["@earendil-works/pi-agent-core", "@bastani/atomic-agent-core", "Agent"],
];

/**
 * Runs the installed package's CLI on a terminal with the extension above, `/reload`s once and quits, and returns what
 * the extension recorded: each generation's identity checks, then each context's retirement through the loader's and
 * through Node's own import of the SDK.
 */
async function identitySession(
	host: "in-process" | "isolated",
	layout: InstalledLayout,
	extraEnv: Record<string, string> = {},
): Promise<IdentityRecord[]> {
	const { nodeModules, atomic } = layout;
	const root = fs.mkdtempSync(join(layoutScope.layoutRoot() as string, `${host}-`));
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
	// What the extension needs to know, beside it: where it records, where native imports resolve from, and the pairs.
	fs.writeFileSync(
		join(project, "fixture.json"),
		JSON.stringify({ record, requireFrom: join(project, "index.cjs"), pairs: SHARED_EXPORTS }),
	);
	fs.writeFileSync(
		extension,
		[
			'import { appendFileSync, readFileSync } from "node:fs";',
			'import { createRequire } from "node:module";',
			'import { revision } from "./revision.ts";',
			...SHARED_EXPORTS.map(([alias], index) => `import * as shared${index} from ${JSON.stringify(alias)};`),
			'const fixture = JSON.parse(readFileSync(new URL("./fixture.json", import.meta.url), "utf8"));',
			'const native = createRequire(fixture.requireFrom)("./native.cjs");',
			'const log = (type, data = {}) => appendFileSync(fixture.record, JSON.stringify({ type, revision, ...data }) + "\\n");',
			"const pairs = fixture.pairs;",
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
		...extraEnv,
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
		await program.waitForScreen((screen) => screen.includes("/reload"), SESSION_TIMEOUT_MS / 4, "/reload typed");
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
	return read();
}

/** One instance of every shared export in each generation, and each context retired through both registrations. */
function assertOneInstanceEach(records: readonly IdentityRecord[]): void {
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
}

for (const host of ["in-process", "isolated"] as const) {
	test(
		`an extension sees one instance of the package's shared exports before and after /reload (${host} host)`,
		async () => assertOneInstanceEach(await identitySession(host, installedLayout())),
		SESSION_TIMEOUT_MS + LAYOUT_TIMEOUT_MS,
	);
}

const RELEASES = ["changes StorageError's constructor", "adds a module StorageError's module imports"] as const;
test.each(RELEASES)(
	"a process that loaded the package keeps one StorageError when it is replaced in place by a release that %s",
	async (release) => {
		const { nodeModules, atomic } = installedLayout();
		const builds = join(dirname(nodeModules), `rebuilds-${RELEASES.indexOf(release)}`);
		const first = join(builds, "first");
		const second = join(builds, "second");
		for (const build of [first, second]) {
			compiledPackage(build);
			if (build === second) {
				// A later release that changed a body in the module defining StorageError.
				const errors = join(build, "dist", "core", "storage", "errors.js");
				const source = fs.readFileSync(errors, "utf8");
				const changed = source.replace(
					"this.name = new.target.name;",
					'this.name = new.target.name;\n        this.rebuilt = "second";',
				);
				assert.notEqual(changed, source, "the rebuild changes StorageError's constructor");
				if (release === RELEASES[0]) fs.writeFileSync(errors, changed);
				else {
					// A new module only errors.js imports, named to sort after the modules beside it: it joins the shared
					// file that holds StorageError without becoming that file's first module.
					const detail = join(build, "dist", "core", "storage", "zz-storage-error-detail.js");
					fs.writeFileSync(detail, 'export const detail = "second";\n');
					const imported = `import { detail } from "./zz-storage-error-detail.js";\n${changed}`;
					fs.writeFileSync(errors, imported.replace('this.rebuilt = "second";', "this.rebuilt = detail;"));
				}
			}
			const split = spawnSync(process.execPath, [join(build, "scripts", "split-dist.mjs")], { encoding: "utf8" });
			assert.equal(split.status, 0, split.stderr);
		}
		const sharedFiles = (build: string) => fs.readdirSync(join(build, "dist", "_shared")).sort();
		assert.deepEqual(sharedFiles(second), sharedFiles(first), "the rebuild names its shared files as before");

		const installed = join(dirname(atomic), `atomic-live-${RELEASES.indexOf(release)}`);
		fs.mkdirSync(installed, { recursive: true });
		fs.copyFileSync(join(first, "package.json"), join(installed, "package.json"));
		copyTree(join(first, "dist"), join(installed, "dist"));
		const project = fs.mkdtempSync(join(dirname(nodeModules), "live-"));
		const probe = join(project, "probe.mjs");
		fs.writeFileSync(
			probe,
			[
				'import { createInterface } from "node:readline";',
				`const base = ${JSON.stringify(pathToFileURL(join(installed, "dist")).href)};`,
				'const storage = await import(base + "/core/storage/index.js");',
				"const before = storage.StorageError;",
				"const existing = Object.create(before.prototype);",
				'console.log("loaded");',
				"for await (const _line of createInterface({ input: process.stdin })) break;",
				'const sdk = await import(base + "/index.js");',
				"console.log(JSON.stringify({ same: sdk.StorageError === before, instance: existing instanceof sdk.StorageError }));",
			].join("\n"),
		);
		const child = spawn(process.execPath, [probe], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const exited = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
		await vi.waitFor(() => assert.ok(stdout.includes("loaded"), stderr), { timeout: LAYOUT_TIMEOUT_MS / 2 });
		// As npm replaces a package: the earlier files leave, the rebuild takes their place.
		await renameWithRetry(join(installed, "dist"), join(installed, "dist-replaced"));
		copyTree(join(second, "dist"), join(installed, "dist"));
		child.stdin.end("go\n");
		assert.equal(await exited, 0, stderr);
		const result = JSON.parse(stdout.trim().split("\n").at(-1) as string) as { same: boolean; instance: boolean };
		assert.deepEqual(result, { same: true, instance: true });
	},
	LAYOUT_TIMEOUT_MS,
);

test(
	"the host and its extensions keep one ModelRegistry when the install is replaced by a release regrouping it while Atomic starts",
	async () => {
		const layout = installedLayout("install-replaced-while-starting");
		const next = join(dirname(layout.nodeModules), "next");
		compiledPackage(next);
		// The release adds a module that only the model registry imports, so it joins the registry's code, named to sort
		// before every module, so it would come first in any file holding the registry.
		const registry = join(next, "dist", "core", "model-registry.js");
		fs.writeFileSync(join(next, "dist", "0-model-registry-revision.js"), "export const revision = 2;\n");
		const source = fs.readFileSync(registry, "utf8");
		assert.ok(source.includes("export class ModelRegistry {"));
		fs.writeFileSync(
			registry,
			`import { revision } from "../0-model-registry-revision.js";\n${source.replace("export class ModelRegistry {", "export class ModelRegistry {\n    static revision = revision;")}`,
		);
		const split = spawnSync(process.execPath, [join(next, "scripts", "split-dist.mjs")], { encoding: "utf8" });
		assert.equal(split.status, 0, split.stderr);
		// The install is replaced, as npm replaces a package, when the host first resolves the SDK entry during startup.
		const preload = join(dirname(layout.nodeModules), "replace-at-sdk.cjs");
		const receipt = join(dirname(layout.nodeModules), "replaced");
		fs.writeFileSync(
			preload,
			[
				'const { registerHooks } = require("node:module");',
				'const { pathToFileURL } = require("node:url");',
				'const fs = require("node:fs");',
				'const path = require("node:path");',
				`const { renameSyncWithRetry } = require(${JSON.stringify(RENAME_RETRY_SYNC_MODULE_PATH)});`,
				'if (process.argv[1]?.endsWith("cli.js") && !process.argv.includes("--internal-engine-prewarm")) {',
				// Node resolves a module to its real path: on macOS the temporary directory /var/folders/... is a link to
				// /private/var/folders/..., so the SDK entry compared with must be written by its real path too.
				`	const dist = ${JSON.stringify(fs.realpathSync(join(layout.atomic, "dist")))};`,
				'	const sdk = pathToFileURL(path.join(dist, "index.js")).href;',
				"	let pending = true;",
				"	registerHooks({",
				"		resolve(specifier, context, nextResolve) {",
				"			const result = nextResolve(specifier, context);",
				"			if (pending && result.url === sdk) {",
				"				pending = false;",
				'				renameSyncWithRetry(dist, dist + "-replaced");',
				`				renameSyncWithRetry(${JSON.stringify(join(next, "dist"))}, dist);`,
				`				fs.writeFileSync(${JSON.stringify(receipt)}, String(process.pid));`,
				"			}",
				"			return result;",
				"		},",
				"	});",
				"}",
			].join("\n"),
		);
		const records = await identitySession("in-process", layout, {
			NODE_OPTIONS: `--require ${JSON.stringify(preload.replaceAll("\\", "/"))}`,
		});
		assert.ok(fs.existsSync(receipt), "the install was replaced while Atomic started");
		assertOneInstanceEach(records);
	},
	SESSION_TIMEOUT_MS + LAYOUT_TIMEOUT_MS,
);
