/**
 * TEMPORARY diagnostic. Runs in vitest's main process after the whole suite.
 *
 * The Windows job passes every test in ~135 s, prints the summary, and then the
 * step sits until the job timeout. `process.getActiveResourcesInfo()` is empty
 * in the vitest main process and the unref'd delay probes below never fire, so
 * the main process has nothing left to do. On Windows a `run:` step ends only
 * when the child exits *and* every inherited stdout/stderr handle closes, so a
 * surviving grandchild that inherited the step's pipe holds the step open.
 *
 * This probe therefore names the survivors instead of counting them: it queries
 * Win32_Process for ProcessId/ParentProcessId/CreationDate/CommandLine and
 * prints each survivor's parent chain up to the runner, plus our own ancestry.
 */
import { spawnSync } from "node:child_process";

export function setup(): void {}

interface ResourceProbe {
	getActiveResourcesInfo?: () => string[];
}

interface WindowsProcess {
	ProcessId: number;
	ParentProcessId: number;
	Name: string;
	CreationDate: string | null;
	CommandLine: string | null;
}

const POWERSHELL_QUERY = [
	"$ErrorActionPreference='Stop';",
	"Get-CimInstance Win32_Process |",
	"Select-Object ProcessId,ParentProcessId,Name,CommandLine,",
	"@{Name='CreationDate';Expression={if($_.CreationDate){$_.CreationDate.ToString('HH:mm:ss')}else{$null}}} |",
	"ConvertTo-Json -Compress -Depth 2",
].join(" ");

/** Names worth naming: the runtimes, shims, and shells this suite can leak. */
const INTERESTING =
	/^(bun|node|deno|vitest|esbuild|atomic|sh|bash|dash|git|cmd|powershell|pwsh|conhost|taskkill|npm|rg|python)/i;

function queryWindowsProcesses(): WindowsProcess[] {
	const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_QUERY], {
		encoding: "utf8",
		windowsHide: true,
		maxBuffer: 32 * 1024 * 1024,
	});
	const stdout = (result.stdout ?? "").trim();
	if (!stdout) {
		console.log(`[exit-probe] Win32_Process query produced no output: ${(result.stderr ?? "").trim()}`);
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(stdout);
		return (Array.isArray(parsed) ? parsed : [parsed]) as WindowsProcess[];
	} catch (error) {
		console.log(`[exit-probe] Win32_Process JSON parse failed: ${String(error)}`);
		return [];
	}
}

function describe(entry: WindowsProcess | undefined, pid: number): string {
	if (!entry) return `pid=${pid} <gone>`;
	const command = (entry.CommandLine ?? "<no command line>").replace(/\s+/g, " ").slice(0, 220);
	return `pid=${entry.ProcessId} ppid=${entry.ParentProcessId} ${entry.Name} started=${entry.CreationDate ?? "?"} :: ${command}`;
}

function chain(byPid: Map<number, WindowsProcess>, pid: number): string[] {
	const lines: string[] = [];
	const seen = new Set<number>();
	let current: number | undefined = pid;
	while (current !== undefined && current > 0 && !seen.has(current)) {
		seen.add(current);
		const entry = byPid.get(current);
		lines.push(`${"  ".repeat(lines.length)}^ ${describe(entry, current)}`);
		current = entry?.ParentProcessId;
	}
	return lines;
}

function dumpWindowsProcessTree(label: string): void {
	const processes = queryWindowsProcesses();
	if (processes.length === 0) return;
	const byPid = new Map(processes.map((entry) => [entry.ProcessId, entry]));
	console.log(`[exit-probe ${label}] self ancestry (pid=${process.pid}, execPath=${process.execPath}):`);
	for (const line of chain(byPid, process.pid)) console.log(`[exit-probe ${label}] ${line}`);

	const survivors = processes.filter((entry) => INTERESTING.test(entry.Name) && entry.ProcessId !== process.pid);
	console.log(`[exit-probe ${label}] candidate survivors: ${survivors.length} (of ${processes.length} total)`);
	for (const entry of survivors) {
		console.log(`[exit-probe ${label}] --- ${describe(entry, entry.ProcessId)}`);
		for (const line of chain(byPid, entry.ParentProcessId)) console.log(`[exit-probe ${label}]    ${line}`);
	}
}

function dump(label: string): void {
	const probe = process as unknown as ResourceProbe;
	const resources = probe.getActiveResourcesInfo?.() ?? ["<getActiveResourcesInfo unavailable>"];
	const counts = new Map<string, number>();
	for (const entry of resources) counts.set(entry, (counts.get(entry) ?? 0) + 1);
	const summary = [...counts.entries()].map(([name, count]) => `${name}x${count}`).join(", ");
	console.log(`[exit-probe ${label}] ${new Date().toISOString()} active resources: ${summary}`);
	if (process.platform === "win32") dumpWindowsProcessTree(label);
}

export function teardown(): void {
	dump("teardown");
	process.on("exit", (code) => {
		console.log(`[exit-probe exit] ${new Date().toISOString()} vitest main process exiting with code=${code}`);
	});
	for (const delaySeconds of [15, 45]) {
		const timer = setTimeout(() => dump(`+${delaySeconds}s`), delaySeconds * 1000);
		timer.unref?.();
	}
}
