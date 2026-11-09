import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll } from "vitest";
import { moduleDir } from "./runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");

export function useBundledNodeFixture(entryPoint: string): (() => Promise<string>) & { dispose(): void } {
	let directory: string | undefined;
	let fixture: Promise<string> | undefined;
	const dispose = () => {
		if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
	};
	afterAll(dispose);

	const getFixture = () => {
		fixture ??= (async () => {
			const parent = join(ROOT, "node_modules", ".cache");
			mkdirSync(parent, { recursive: true });
			directory = mkdtempSync(join(parent, `${basename(entryPoint, ".ts")}-`));
			const outfile = join(directory, "fixture.mjs");
			await build({
				entryPoints: [entryPoint],
				outfile,
				bundle: true,
				platform: "node",
				format: "esm",
				packages: "external",
				logLevel: "warning",
			});
			return outfile;
		})();
		return fixture;
	};
	return Object.assign(getFixture, { dispose });
}
