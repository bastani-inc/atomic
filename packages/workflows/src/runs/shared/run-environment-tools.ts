import path from "node:path";
import {
	createEditToolDefinition,
	createHashlineSnapshotStore,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type HashlineSnapshotStore,
	type LsOperations,
	type ReadOperations,
	resolvePath,
	type WriteOperations,
} from "@bastani/atomic";

import {
	bashResultFromExecOutcome,
	type RemoteCommand,
	type RemoteOperatingSystem,
	type RunEnvironmentExecTransport,
} from "./run-environment-exec.js";

export interface RunEnvironmentToolOperationsOptions {
	readonly transport: RunEnvironmentExecTransport;
}

function operatingSystem(options: RunEnvironmentToolOperationsOptions): RemoteOperatingSystem {
	return options.transport.agent.operatingSystem;
}

interface CollectedCommandResult {
	readonly stdout: Buffer;
	readonly stderr: Buffer;
	readonly exitCode: number;
}

interface RemoteDirectoryEntry {
	readonly name: string;
	readonly path: string;
	readonly isDirectory: boolean;
	readonly mtimeMs: number;
	readonly size: number;
}

interface RemoteReadProbe {
	readonly isDirectory: boolean;
	readonly listings: Map<string, RemoteDirectoryEntry[]>;
}

interface RemoteToolState {
	readonly files: Map<string, Buffer>;
	readonly reads: Map<string, RemoteReadProbe>;
	readonly hashlineStore: HashlineSnapshotStore;
}

const neverAbortedSignal = new AbortController().signal;
const states = new WeakMap<RunEnvironmentExecTransport, RemoteToolState>();

function stateFor(options: RunEnvironmentToolOperationsOptions): RemoteToolState {
	let state = states.get(options.transport);
	if (state === undefined) {
		state = { files: new Map(), reads: new Map(), hashlineStore: createHashlineSnapshotStore() };
		states.set(options.transport, state);
	}
	return state;
}

function targetPath(operatingSystem: RemoteOperatingSystem): path.PlatformPath {
	return operatingSystem === "windows" ? path.win32 : path.posix;
}

async function executeCommand(
	options: RunEnvironmentToolOperationsOptions,
	command: RemoteCommand,
	signal: AbortSignal = neverAbortedSignal,
): Promise<CollectedCommandResult> {
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	const outcome = await options.transport.execute(
		command,
		{
			write(chunk, channel) {
				(channel === "stdout" ? stdout : stderr).push(Buffer.from(chunk));
			},
		},
		signal,
	);
	return {
		stdout: Buffer.concat(stdout),
		stderr: Buffer.concat(stderr),
		exitCode: bashResultFromExecOutcome(outcome).exitCode,
	};
}

function commandError(command: RemoteCommand, result: CollectedCommandResult): Error {
	const detail = result.stderr.toString("utf8").trim();
	return new Error(detail || `${command.argv[0] ?? "Remote command"} exited with code ${result.exitCode}`);
}

async function executeSuccessful(
	options: RunEnvironmentToolOperationsOptions,
	command: RemoteCommand,
	signal?: AbortSignal,
): Promise<Buffer> {
	const result = await executeCommand(options, command, signal);
	if (result.exitCode !== 0) throw commandError(command, result);
	return result.stdout;
}

function powershell(script: string, ...args: string[]): readonly string[] {
	return ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, ...args];
}

const POSIX_READ_SCRIPT = `if [ ! -e "$1" ] && [ ! -L "$1" ]; then exit 2; fi; if [ ! -d "$1" ]; then printf "F\\0"; cat -- "$1"; exit; fi; root=$1; mode=$2; emit() { entry=$1; if [ -d "$entry" ]; then kind=d; size=0; else kind=f; if [ "$mode" = darwin ]; then size=$(stat -f %z "$entry"); else size=$(stat -c %s "$entry"); fi; fi; if [ "$mode" = darwin ]; then mtime=$(stat -f %m "$entry"); else mtime=$(stat -c %Y "$entry"); fi; rel=\${entry#"$root"/}; printf "%s\\0%s\\0%s\\0%s\\0" "$kind" "$rel" "$mtime" "$size"; }; printf "D\\0"; for entry in "$root"/.[!.]* "$root"/..?* "$root"/*; do [ -e "$entry" ] || [ -L "$entry" ] || continue; emit "$entry"; if [ -d "$entry" ]; then for child in "$entry"/.[!.]* "$entry"/..?* "$entry"/*; do [ -e "$child" ] || [ -L "$child" ] || continue; emit "$child"; done; fi; done`;
const WINDOWS_READ_SCRIPT =
	'$ErrorActionPreference=\'Stop\'; if (-not (Test-Path -LiteralPath $args[0])) { exit 2 }; $item=Get-Item -Force -LiteralPath $args[0]; $out=[Console]::OpenStandardOutput(); $utf8=[Text.UTF8Encoding]::new($false); if (-not $item.PSIsContainer) { $marker=$utf8.GetBytes("F`0"); $out.Write($marker,0,$marker.Length); $stream=[IO.File]::OpenRead($args[0]); try { $stream.CopyTo($out) } finally { $stream.Dispose() }; exit 0 }; $marker=$utf8.GetBytes("D`0"); $out.Write($marker,0,$marker.Length); Get-ChildItem -Force -LiteralPath $args[0] -Recurse -Depth 1 | ForEach-Object { $relative=$_.FullName.Substring($item.FullName.Length).TrimStart(\'\\\',\'/\'); $kind=if ($_.PSIsContainer) {\'d\'} else {\'f\'}; $size=if ($_.PSIsContainer) {0} else {$_.Length}; $mtime=[DateTimeOffset]$_.LastWriteTimeUtc; $record=$utf8.GetBytes($kind+"`0"+$relative+"`0"+$mtime.ToUnixTimeSeconds()+"`0"+$size+"`0"); $out.Write($record,0,$record.Length) }';

function readArgv(operatingSystem: RemoteOperatingSystem, filePath: string): readonly string[] {
	return operatingSystem === "windows"
		? powershell(WINDOWS_READ_SCRIPT, filePath)
		: ["sh", "-c", POSIX_READ_SCRIPT, "atomic-read", filePath, operatingSystem];
}

const POSIX_WRITE_SCRIPT =
	'if [ -f "$1" ] && head -c 8192 -- "$1" | head -n 40 | grep -Eiq "@generated|auto-generated|DO NOT EDIT|GENERATED -- do not edit"; then printf "Refusing to overwrite generated file: %s\\n" "$1" >&2; exit 3; fi; parent=$(dirname "$1") && mkdir -p "$parent" && tmp="$1.atomic-write-$$" && trap \'rm -f "$tmp"\' EXIT HUP INT TERM && cat > "$tmp" && mv -f "$tmp" "$1" || exit; trap - EXIT HUP INT TERM; if [ "$(head -c 2 -- "$1")" = "#!" ]; then chmod a+x "$1" && printf X; else printf N; fi';
const WINDOWS_WRITE_SCRIPT =
	'$ErrorActionPreference=\'Stop\'; if ([IO.File]::Exists($args[0])) { $reader=[IO.StreamReader]::new($args[0]); try { $lines=@(); for ($i=0; $i -lt 40 -and -not $reader.EndOfStream; $i++) { $lines += $reader.ReadLine() }; if (($lines -join "`n") -match "@generated|auto-generated|DO NOT EDIT|GENERATED -- do not edit") { [Console]::Error.WriteLine("Refusing to overwrite generated file: "+$args[0]); exit 3 } } finally { $reader.Dispose() } }; $parent=[IO.Path]::GetDirectoryName($args[0]); if ($parent) { [IO.Directory]::CreateDirectory($parent) > $null }; $tmp=$args[0]+\'.atomic-write-\'+[Diagnostics.Process]::GetCurrentProcess().Id; $bytes=[Convert]::FromBase64String(($input -join \'\')); [IO.File]::WriteAllBytes($tmp,$bytes); if ([IO.File]::Exists($args[0])) { [IO.File]::Delete($args[0]) }; [IO.File]::Move($tmp,$args[0]); [Console]::Write("N")';

function writeCommand(operatingSystem: RemoteOperatingSystem, filePath: string, content: string): RemoteCommand {
	const bytes = Buffer.from(content, "utf8");
	return {
		argv:
			operatingSystem === "windows"
				? powershell(WINDOWS_WRITE_SCRIPT, filePath)
				: ["sh", "-c", POSIX_WRITE_SCRIPT, "atomic-write", filePath],
		stdin: operatingSystem === "windows" ? Buffer.from(bytes.toString("base64"), "ascii") : bytes,
	};
}

function parseReadProbe(
	buffer: Buffer,
	filePath: string,
	operatingSystem: RemoteOperatingSystem,
): { readonly probe: RemoteReadProbe; readonly content?: Buffer } {
	const markerEnd = buffer.indexOf(0);
	if (markerEnd < 0) throw new Error(`Invalid remote read response for ${filePath}`);
	const marker = buffer.subarray(0, markerEnd).toString("ascii");
	if (marker === "F")
		return { probe: { isDirectory: false, listings: new Map() }, content: buffer.subarray(markerEnd + 1) };
	if (marker !== "D") throw new Error(`Invalid remote read response for ${filePath}`);
	const paths = targetPath(operatingSystem);
	const listings = new Map<string, RemoteDirectoryEntry[]>([[filePath, []]]);
	const fields = buffer
		.subarray(markerEnd + 1)
		.toString("utf8")
		.split("\0");
	for (let index = 0; index + 3 < fields.length; index += 4) {
		const kind = fields[index];
		const relativePath = fields[index + 1];
		if (!relativePath || (kind !== "d" && kind !== "f")) continue;
		const absolutePath = paths.join(filePath, relativePath.replace(/[\\/]/gu, paths.sep));
		const parent = paths.dirname(absolutePath);
		const entry: RemoteDirectoryEntry = {
			name: paths.basename(absolutePath),
			path: absolutePath,
			isDirectory: kind === "d",
			mtimeMs: Number(fields[index + 2] ?? 0) * 1_000,
			size: Number(fields[index + 3] ?? 0),
		};
		const siblings = listings.get(parent) ?? [];
		siblings.push(entry);
		listings.set(parent, siblings);
		if (entry.isDirectory && !listings.has(absolutePath)) listings.set(absolutePath, []);
	}
	return { probe: { isDirectory: true, listings } };
}

export function createRunEnvironmentReadOperations(options: RunEnvironmentToolOperationsOptions): ReadOperations {
	const state = stateFor(options);
	const system = operatingSystem(options);
	async function probe(filePath: string): Promise<RemoteReadProbe> {
		const cached = state.reads.get(filePath);
		if (cached !== undefined) return cached;
		const output = await executeSuccessful(options, { argv: readArgv(operatingSystem(options), filePath) });
		const parsed = parseReadProbe(output, filePath, operatingSystem(options));
		state.reads.set(filePath, parsed.probe);
		if (parsed.content !== undefined) state.files.set(filePath, parsed.content);
		return parsed.probe;
	}
	return {
		resolvePath: (filePath, cwd) =>
			resolvePath(filePath, cwd, { expandTilde: false, pathStyle: system === "windows" ? "windows" : "posix" }),
		async access(filePath) {
			await probe(filePath);
		},
		async readFile(filePath) {
			await probe(filePath);
			const content = state.files.get(filePath);
			if (content === undefined) throw new Error(`Cannot read directory as a file: ${filePath}`);
			return content;
		},
		async stat(filePath) {
			const read = await probe(filePath);
			return { isFile: !read.isDirectory, isDirectory: read.isDirectory };
		},
		async listDir(filePath) {
			for (const read of state.reads.values()) {
				const listing = read.listings.get(filePath);
				if (listing !== undefined) return listing;
			}
			return undefined;
		},
	};
}

export function createRunEnvironmentWriteOperations(options: RunEnvironmentToolOperationsOptions): WriteOperations {
	const state = stateFor(options);
	const writeFileSafely = async (filePath: string, content: string): Promise<{ readonly madeExecutable: boolean }> => {
		const output = await executeSuccessful(options, writeCommand(operatingSystem(options), filePath, content));
		state.files.set(filePath, Buffer.from(content));
		return { madeExecutable: output.toString("ascii") === "X" };
	};
	return {
		async mkdir() {
			// writeFileSafely creates its parent in the same remote command.
		},
		async writeFile(filePath, content) {
			await writeFileSafely(filePath, content);
		},
		writeFileSafely,
	};
}

export function createRunEnvironmentEditOperations(options: RunEnvironmentToolOperationsOptions): EditOperations {
	const state = stateFor(options);
	const system = operatingSystem(options);
	return {
		resolvePath: (filePath, cwd) =>
			resolvePath(filePath, cwd, { expandTilde: false, pathStyle: system === "windows" ? "windows" : "posix" }),
		async access(filePath) {
			if (!state.files.has(filePath)) throw new Error(`Remote edit requires a read snapshot for ${filePath}`);
		},
		async readFile(filePath) {
			const content = state.files.get(filePath);
			if (content === undefined) throw new Error(`Remote edit requires a read snapshot for ${filePath}`);
			return content;
		},
		async writeFile(filePath, content) {
			state.files.set(filePath, Buffer.from(content));
		},
	};
}

function listingArgv(operatingSystem: RemoteOperatingSystem, directory: string): readonly string[] {
	if (operatingSystem === "windows") {
		return powershell(
			'$ErrorActionPreference=\'Stop\'; if (-not (Test-Path -LiteralPath $args[0])) { exit 2 }; $item=Get-Item -LiteralPath $args[0]; $out=[Console]::OpenStandardOutput(); $utf8=[Text.UTF8Encoding]::new($false); if (-not $item.PSIsContainer) { $bytes=$utf8.GetBytes("F`0"); $out.Write($bytes,0,$bytes.Length); exit 0 }; $bytes=$utf8.GetBytes("D`0"); $out.Write($bytes,0,$bytes.Length); Get-ChildItem -Force -LiteralPath $args[0] | ForEach-Object { $kind=if ($_.PSIsContainer) {\'d\'} else {\'f\'}; $bytes=$utf8.GetBytes($kind+"`0"+$_.Name+"`0"); $out.Write($bytes,0,$bytes.Length) }',
			directory,
		);
	}
	return [
		"sh",
		"-c",
		`if [ ! -e "$1" ] && [ ! -L "$1" ]; then exit 2; fi; if [ ! -d "$1" ]; then printf "F\\0"; exit 0; fi; printf "D\\0"; for entry in "$1"/.[!.]* "$1"/..?* "$1"/*; do [ -e "$entry" ] || [ -L "$entry" ] || continue; if [ -d "$entry" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "\${entry##*/}"; done`,
		"atomic-ls",
		directory,
	];
}

interface Listing {
	readonly rootIsDirectory: boolean;
	readonly entries: Map<string, boolean>;
}

function parseListing(buffer: Buffer): Listing {
	const fields = buffer.toString("utf8").split("\0");
	const rootMarker = fields[0];
	const hasRootMarker = rootMarker === "D" || rootMarker === "F";
	const entries = new Map<string, boolean>();
	for (let index = hasRootMarker ? 1 : 0; index + 1 < fields.length; index += 2) {
		const kind = fields[index];
		const name = fields[index + 1];
		if (name) entries.set(name, kind === "d");
	}
	return { rootIsDirectory: rootMarker !== "F", entries };
}

export function createRunEnvironmentLsOperations(options: RunEnvironmentToolOperationsOptions): LsOperations {
	const listings = new Map<string, Listing>();
	const paths = targetPath(operatingSystem(options));
	return {
		async exists(filePath) {
			const command = { argv: listingArgv(operatingSystem(options), filePath) };
			const result = await executeCommand(options, command);
			if (result.exitCode === 2) return false;
			if (result.exitCode !== 0) throw commandError(command, result);
			listings.set(filePath, parseListing(result.stdout));
			return true;
		},
		stat(filePath) {
			const own = listings.get(filePath);
			if (own !== undefined) return { isDirectory: () => own.rootIsDirectory };
			const parent = listings.get(paths.dirname(filePath));
			const isDirectory = parent?.entries.get(paths.basename(filePath));
			if (isDirectory === undefined) throw new Error(`Path not found: ${filePath}`);
			return { isDirectory: () => isDirectory };
		},
		readdir(filePath) {
			const listing = listings.get(filePath);
			if (listing === undefined) throw new Error(`Path not listed: ${filePath}`);
			return [...listing.entries.keys()];
		},
	};
}
function patchWithSnapshotLineEndings(patch: string, snapshots: readonly Buffer[]): string {
	const starts = [...patch.matchAll(/^--- .*\n\+\+\+ .*$/gmu)].map((match) => match.index);
	if (starts.length !== snapshots.length) return patch;
	return starts
		.map((start, index) => {
			const section = patch.slice(start, starts[index + 1] ?? patch.length);
			return snapshots[index]!.includes("\r\n") ? section.replace(/\n/gu, "\r\n") : section;
		})
		.join("");
}

export type RemoteFilesystemSelectorKind = "archive" | "internal" | "notebook" | "path" | "sqlite" | "url";

export class RemoteFilesystemSelectorError extends Error {
	constructor(
		readonly toolName: "edit" | "read" | "write",
		readonly selectorKind: RemoteFilesystemSelectorKind,
		readonly selector: string,
	) {
		super(`${toolName} does not support remote ${selectorKind} selectors: ${selector}`);
		this.name = "RemoteFilesystemSelectorError";
	}
}

function remoteSelectorKind(value: string, rejectNotebook = false): RemoteFilesystemSelectorKind | undefined {
	if (/^https?:\/\//iu.test(value)) return "url";
	if (/^[a-z]+:\/\//iu.test(value)) return "internal";
	if (/\.(?:zip|jar|tar|tgz|tar\.gz|gz):/iu.test(value)) return "archive";
	if (/\.(?:sqlite|sqlite3|db|db3)(?:$|[?:])/iu.test(value)) return "sqlite";
	if (rejectNotebook && /\.ipynb(?:$|:)/iu.test(value)) return "notebook";
	return undefined;
}

export function createRunEnvironmentReadToolDefinition(cwd: string, options: RunEnvironmentToolOperationsOptions) {
	const state = stateFor(options);
	const builtin = createReadToolDefinition(cwd, {
		operations: createRunEnvironmentReadOperations(options),
		hashlineStore: state.hashlineStore,
	});
	return {
		...builtin,
		async execute(...args: Parameters<typeof builtin.execute>) {
			const [, input] = args;
			const selectorKind = remoteSelectorKind(input.path, true);
			if (selectorKind !== undefined) throw new RemoteFilesystemSelectorError("read", selectorKind, input.path);
			state.reads.clear();
			return builtin.execute(...args);
		},
	};
}

export function createRunEnvironmentWriteToolDefinition(cwd: string, options: RunEnvironmentToolOperationsOptions) {
	const state = stateFor(options);
	const builtin = createWriteToolDefinition(cwd, {
		operations: createRunEnvironmentWriteOperations(options),
		hashlineStore: state.hashlineStore,
	});
	return {
		...builtin,
		async execute(...args: Parameters<typeof builtin.execute>) {
			const [, input] = args;
			const selectorKind = remoteSelectorKind(input.path);
			const selectorColon = input.path.indexOf(":", /^[A-Za-z]:[\\/]/u.test(input.path) ? 2 : 0);
			const refusedKind =
				selectorKind ?? (input.path.includes("?") ? "path" : selectorColon >= 0 ? "path" : undefined);
			if (refusedKind !== undefined) throw new RemoteFilesystemSelectorError("write", refusedKind, input.path);
			return builtin.execute(...args);
		},
	};
}

export function createRunEnvironmentEditToolDefinition(cwd: string, options: RunEnvironmentToolOperationsOptions) {
	const state = stateFor(options);
	const builtin = createEditToolDefinition(cwd, {
		operations: createRunEnvironmentEditOperations(options),
		hashlineStore: state.hashlineStore,
	});
	const remoteApplications = new WeakMap<object, Promise<void>>();
	return {
		...builtin,
		async execute(...args: Parameters<typeof builtin.execute>) {
			const [toolCallId, input, signal, onUpdate, context] = args;
			const snapshots: Buffer[] = [];
			for (const match of input.input.matchAll(/^\[([^\]\n]+)#([0-9A-Fa-f]{4})\]$/gmu)) {
				const selector = match[1] ?? "";
				const selectorKind = remoteSelectorKind(selector, true);
				if (selectorKind !== undefined) throw new RemoteFilesystemSelectorError("edit", selectorKind, selector);
				const snapshot = state.hashlineStore.findByHeader(match[1] ?? "", match[2] ?? "");
				if (snapshot !== undefined) {
					const content = state.files.get(snapshot.absolutePath) ?? Buffer.from(snapshot.content);
					state.files.set(snapshot.absolutePath, content);
					snapshots.push(content);
				}
			}
			const before = new Map(state.files);
			try {
				const result = await builtin.execute(toolCallId, input, signal, onUpdate, context);
				const patch = result.details?.patch ?? "";
				const existingApplication = remoteApplications.get(result);
				if (existingApplication !== undefined) {
					await existingApplication.catch(() => undefined);
					await executeSuccessful(
						options,
						{
							argv: [
								operatingSystem(options) === "windows" ? "git.exe" : "git",
								"rev-parse",
								"--is-inside-work-tree",
							],
							cwd,
						},
						signal,
					);
					await existingApplication;
					return result;
				}
				const command: RemoteCommand =
					patch === ""
						? {
								argv: [
									operatingSystem(options) === "windows" ? "git.exe" : "git",
									"rev-parse",
									"--is-inside-work-tree",
								],
								cwd,
							}
						: {
								argv: [
									operatingSystem(options) === "windows" ? "git.exe" : "git",
									"apply",
									"-p0",
									"--recount",
									"--whitespace=nowarn",
									"-",
								],
								cwd,
								stdin: Buffer.from(patchWithSnapshotLineEndings(patch, snapshots)),
							};
				const application = executeSuccessful(options, command, signal).then(() => undefined);
				remoteApplications.set(result, application);
				await application;
				return result;
			} catch (error) {
				state.files.clear();
				for (const [filePath, content] of before) state.files.set(filePath, content);
				throw error;
			}
		},
	};
}

export function createRunEnvironmentLsToolDefinition(cwd: string, options: RunEnvironmentToolOperationsOptions) {
	return createLsToolDefinition(cwd, { operations: createRunEnvironmentLsOperations(options) });
}
