import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CombinedAutocompleteProvider,
	type Component,
	Text,
	TuiAltScreen,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import { bunExecutable, removeTempDirs } from "./cli-test-helpers.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

const MAX_RENDER_WRITE_CHARS = 1024 * 1024;
/** Structural: Windows cannot spawn a shebang script, so the fd fixture is bun-compiled to an .exe. */
const WINDOWS_COMPILED_FD_FIXTURE_TIMEOUT_MS = 120_000;
const tempDirs: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "atomic-pi-0.85.0-"));
	tempDirs.push(path);
	return path;
}

function makeDirectory(path: string): void {
	mkdirSync(path, { recursive: true });
}

function fakeFd(base: string): string {
	const scriptPath = join(base, "fd-fixture.mjs");
	writeFileSync(
		scriptPath,
		`#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
const args = process.argv.slice(2);
const base = args[args.indexOf("--base-directory") + 1];
const maxDepthAt = args.indexOf("--max-depth");
const maxDepth = maxDepthAt === -1 ? Infinity : Number(args[maxDepthAt + 1]);
const maxResults = Number(args[args.indexOf("--max-results") + 1]);
const lastArg = args.at(-1);
const query = lastArg && !lastArg.startsWith("-") && lastArg !== ".git/**" ? lastArg.toLowerCase() : "";
const rows = [];
function walk(dir, depth) {
  if (depth > maxDepth || rows.length >= maxResults) return;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    const display = relative(base, full).replaceAll("\\\\", "/") + (entry.isDirectory() ? "/" : "");
    if (!query || display.toLowerCase().includes(query)) rows.push(display);
    if (entry.isDirectory()) walk(full, depth + 1);
    if (rows.length >= maxResults) return;
  }
}
walk(base, 1);
process.stdout.write(rows.join("\\n"));
`,
	);
	if (process.platform !== "win32") {
		chmodSync(scriptPath, 0o755);
		return scriptPath;
	}

	// pi-tui spawn()s fd without a shell. Node 22+ will not CreateProcess a shebang
	// script or a .cmd shim, so Windows needs a real PE executable.
	const outfile = join(base, "fd-fixture.exe");
	const compiled = spawnSync(bunExecutable(), ["build", "--compile", scriptPath, "--outfile", outfile], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (compiled.error || compiled.status !== 0) {
		const detail = compiled.error?.message ?? (compiled.stderr || compiled.stdout || `status ${compiled.status}`);
		throw new Error(`Failed to compile Windows fd fixture: ${detail}`);
	}
	return outfile;
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
	removeTempDirs(tempDirs);
});

describe("pi-tui 0.85.0 dependency behavior", () => {
	test(
		"scoped autocomplete keeps a direct child ahead of flooded nested matches",
		async () => {
			const base = tempDir();
			makeDirectory(join(base, "scope/projects"));
			for (let index = 1; index <= 250; index += 1) {
				makeDirectory(
					join(
						base,
						`scope/a${String(index).padStart(3, "0")}/venv/lib/python3.12/site-packages/pkg/core/profile`,
					),
				);
			}
			const provider = new CombinedAutocompleteProvider([], base, fakeFd(base));
			const line = "@scope/pro";
			const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
			const values = result?.items.map((item) => item.value) ?? [];

			expect(values[0]).toBe("@scope/projects/");
			expect(values.some((value) => value.includes("/profile/"))).toBe(true);
		},
		process.platform === "win32" ? WINDOWS_COMPILED_FD_FIXTURE_TIMEOUT_MS : undefined,
	);

	test("main-screen rendering chunks more than 1 MiB without splitting surrogate pairs", () => {
		const terminal = new RecordingTerminal();
		const tui = new TuiMainScreen(terminal);
		const line = `${"A".repeat(MAX_RENDER_WRITE_CHARS - 1)}😀${"B".repeat(MAX_RENDER_WRITE_CHARS + 10)}`;
		const component: Component = {
			render: () => [line],
			invalidate: () => {},
		};
		tui.addChild(component);

		tui.renderNow();

		expect(terminal.writes.length).toBeGreaterThan(2);
		expect(terminal.writes.every((write) => write.length <= MAX_RENDER_WRITE_CHARS)).toBe(true);
		for (let index = 0; index < terminal.writes.length - 1; index += 1) {
			const left = terminal.writes[index] ?? "";
			const right = terminal.writes[index + 1] ?? "";
			expect(/[\uD800-\uDBFF]$/u.test(left)).toBe(false);
			expect(/^[\uDC00-\uDFFF]/u.test(right)).toBe(false);
		}
		const output = terminal.writes.join("");
		expect(output.startsWith("\x1b[?2026h")).toBe(true);
		expect(output.endsWith("\x1b[?2026l")).toBe(true);
		expect(output.includes(line)).toBe(true);
	});

	test("double-click selects complete slash and kebab paths", async () => {
		for (const { line, needle } of [
			{ line: "extensions/starline/fixed-editor/compositor.ts", needle: "starline" },
			{ line: "earendil-works/pi-tui", needle: "works" },
		]) {
			const copied: string[] = [];
			const terminal = new RecordingTerminal();
			terminal.rows = 1;
			terminal.columns = 80;
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				copySelection: async (text) => {
					copied.push(text);
					return true;
				},
			});
			tui.addChild(new Text(line, 0, 0));
			tui.start();
			tui.renderNow();

			const column = line.indexOf(needle) + 1;
			terminal.input(`\x1b[<0;${column};1M`);
			terminal.input(`\x1b[<0;${column};1m`);
			terminal.input(`\x1b[<0;${column};1M`);
			terminal.input(`\x1b[<0;${column};1m`);
			await settle();

			expect(copied).toEqual([line]);
			tui.stop();
		}
	});
});
