import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WINDOWS_BYTECODE_PROBE_BUN_VERSION = "1.4.0";

export const WINDOWS_BYTECODE_PROBE_TARGETS = [
	{
		platform: "windows-x64",
		target: "bun-windows-x64-baseline",
		machine: 0x8664,
	},
	{
		platform: "windows-arm64",
		target: "bun-windows-arm64",
		machine: 0xaa64,
	},
] as const;

export function windowsBytecodeCompileArgs(target: string, loaderPath: string, outputPath: string): string[] {
	return [
		"build",
		"--compile",
		"--bytecode",
		"--format=cjs",
		"--external",
		"mupdf",
		"--no-compile-autoload-dotenv",
		"--no-compile-autoload-bunfig",
		`--target=${target}`,
		loaderPath,
		"--outfile",
		outputPath,
	];
}

export function readPortableExecutableMachine(path: string): number {
	const binary = readFileSync(path);
	if (binary.length < 0x40 || binary.toString("ascii", 0, 2) !== "MZ") {
		throw new Error(`${path} is not a PE executable`);
	}
	const peOffset = binary.readUInt32LE(0x3c);
	if (peOffset + 6 > binary.length || binary.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
		throw new Error(`${path} has no valid PE header`);
	}
	return binary.readUInt16LE(peOffset + 4);
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function outputDirectory(args: readonly string[]): string {
	const index = args.indexOf("--outdir");
	if (index === -1) return mkdtempSync(join(tmpdir(), "atomic-windows-bytecode-"));
	const value = args[index + 1];
	if (!value) throw new Error("--outdir requires a path");
	return resolve(value);
}

export function runWindowsBytecodeProbe(args: readonly string[] = process.argv.slice(2)): void {
	const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const loaderPath = join(repositoryRoot, "packages", "coding-agent", "dist", "bun", "split-loader.js");
	if (!existsSync(loaderPath)) {
		throw new Error(`Missing ${loaderPath}. Run npm --workspace=@bastani/atomic run build first.`);
	}
	const version = spawnSync("bun", ["--version"], { encoding: "utf8" });
	if (version.status !== 0) throw new Error(version.stderr || "bun --version failed");
	const actualVersion = version.stdout.trim();
	if (actualVersion !== WINDOWS_BYTECODE_PROBE_BUN_VERSION) {
		throw new Error(
			`Windows bytecode probe requires Bun ${WINDOWS_BYTECODE_PROBE_BUN_VERSION}, found ${actualVersion}`,
		);
	}
	const outdir = outputDirectory(args);
	mkdirSync(outdir, { recursive: true });
	console.log(`Bun ${actualVersion}`);
	console.log(`Output ${outdir}`);
	for (const spec of WINDOWS_BYTECODE_PROBE_TARGETS) {
		const outputPath = join(outdir, `atomic-${spec.platform}.exe`);
		const result = spawnSync("bun", windowsBytecodeCompileArgs(spec.target, loaderPath, outputPath), {
			cwd: repositoryRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.status !== 0) {
			throw new Error([result.stdout, result.stderr].filter(Boolean).join("\n"));
		}
		const machine = readPortableExecutableMachine(outputPath);
		if (machine !== spec.machine) {
			throw new Error(
				`${spec.platform} PE machine 0x${machine.toString(16)} did not match 0x${spec.machine.toString(16)}`,
			);
		}
		console.log(
			JSON.stringify({
				platform: spec.platform,
				target: spec.target,
				bytecode: true,
				machine: `0x${machine.toString(16)}`,
				bytes: readFileSync(outputPath).byteLength,
				sha256: sha256(outputPath),
				outputPath,
			}),
		);
	}
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
	runWindowsBytecodeProbe();
}
