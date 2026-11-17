#!/usr/bin/env node
/**
 * Fails when a blocking API is reachable from the interactive host's entry points.
 *
 *   node scripts/event-loop/check-event-loop.ts             violations, exit 1 when there are any
 *   node scripts/event-loop/check-event-loop.ts --json      the same as JSON
 *   node scripts/event-loop/check-event-loop.ts --explain 'packages/tui/src/tui.ts#TuiBase.render'
 *
 * See scripts/event-loop/README.md for what is checked and how to fix or review a finding.
 */
import { type CallGraph, CallGraphBuilder, type GraphFunction } from "./call-graph.ts";
import {
	type EventLoopPolicy,
	type FunctionSelector,
	INTERACTIVE_HOST_POLICY,
	type ReviewedSelector,
} from "./policy.ts";
import { ANALYSIS_TSCONFIG, openProject, REPO_ROOT } from "./program.ts";
import { type Arrival, pathTo, type Reached, reach, registrationsByRegistrar } from "./reachability.ts";
import { findBacktrackingRisks } from "./regex-safety.ts";

/** A regular expression on an interactive path that can backtrack super-linearly on some input. */
export interface RegexFinding {
	readonly file: string;
	readonly line: number;
	readonly pattern: string;
	readonly flags: string;
	readonly kind: string;
	readonly reason: string;
	readonly function: string;
}

export interface Violation {
	readonly file: string;
	readonly line: number;
	readonly api: string;
	readonly category: string;
	readonly function: string;
	readonly inAsyncFunction: boolean;
	/** Set when another open change owns this call (`OWNED_ELSEWHERE`); such findings do not fail the check. */
	readonly ownedBy: string | undefined;
	readonly path: readonly string[];
}

export interface EventLoopReport {
	/** Findings that fail the check. */
	readonly violations: readonly Violation[];
	/** Findings in areas another open change owns. */
	readonly deferred: readonly Violation[];
	/** Backtracking regular expressions on interactive paths that no reviewed entry accepts. */
	readonly regexFindings: readonly RegexFinding[];
	readonly warnings: readonly string[];
	readonly policyErrors: readonly string[];
	readonly reachableFunctions: number;
	readonly processFunctions: number;
	readonly interactiveRoots: number;
	readonly graph: CallGraph;
	readonly interactive: Reached;
}

function selectorKey(selector: FunctionSelector): string {
	return `${selector.file}#${selector.name}`;
}

function indexByName(graph: CallGraph): Map<string, number> {
	const index = new Map<string, number>();
	for (const fn of graph.functions) index.set(`${fn.file}#${fn.name}`, fn.id);
	return index;
}

function describe(fn: GraphFunction): string {
	return `${fn.file}:${fn.line} ${fn.name}`;
}

function describeArrival(graph: CallGraph, id: number, arrival: Arrival): string {
	const fn = graph.functions[id];
	switch (arrival.kind) {
		case "root":
			return `${describe(fn)} [${arrival.reason}]`;
		case "edge":
			return `${describe(fn)} (${arrival.edge})`;
		case "registered":
			return `${describe(fn)} (registered with ${arrival.sink} at line ${arrival.line})`;
	}
}

/** The top-level nodes of the startup modules and of everything they import statically. */
function startupModuleNodes(graph: CallGraph, startupModules: readonly string[], policyErrors: string[]): Set<number> {
	const files = new Set<string>();
	const stack: string[] = [];
	for (const file of startupModules) {
		if (!graph.modules.has(file)) policyErrors.push(`STARTUP_MODULES: no module ${file}`);
		else stack.push(file);
	}
	while (stack.length > 0) {
		const file = stack.pop() as string;
		if (files.has(file)) continue;
		files.add(file);
		for (const imported of graph.staticImports.get(file) ?? []) stack.push(imported);
	}
	const nodes = new Set<number>();
	for (const file of files) {
		const id = graph.modules.get(file);
		if (id !== undefined) nodes.add(id);
	}
	return nodes;
}

export function analyzeEventLoop(graph: CallGraph, policy: EventLoopPolicy = INTERACTIVE_HOST_POLICY): EventLoopReport {
	const byName = indexByName(graph);
	const policyErrors: string[] = [];
	const resolve = (selector: FunctionSelector, list: string): number | undefined => {
		const id = byName.get(selectorKey(selector));
		if (id === undefined) policyErrors.push(`${list}: no function ${selectorKey(selector)}`);
		return id;
	};
	const reviewed = (entries: readonly ReviewedSelector[], list: string) => {
		const map = new Map<number, string>();
		for (const entry of entries) {
			if (entry.reason.trim().length < 20) policyErrors.push(`${list}: ${selectorKey(entry)} needs a reason`);
			const id = resolve(entry, list);
			if (id !== undefined) map.set(id, entry.reason);
		}
		return map;
	};

	const registrations = registrationsByRegistrar(graph);
	const entries = new Map<number, string>();
	for (const selector of policy.processEntries) {
		const id = resolve(selector, "PROCESS_ENTRIES");
		if (id !== undefined) entries.set(id, "process entry");
	}
	const otherModes = reviewed(policy.otherModes, "OTHER_MODES");
	const process = reach(graph, entries, { stopAt: otherModes, followRegistrations: true }, registrations);

	const roots = new Map<number, string>();
	for (const root of policy.interfaceRoots) {
		for (const member of root.members) {
			const implementations = graph.implementationsOf(root.file, root.type, member);
			if (implementations.length === 0)
				policyErrors.push(`INTERFACE_ROOTS: no implementation of ${root.type}.${member}`);
			for (const id of implementations) roots.set(id, `${root.type}.${member}`);
		}
	}
	for (const registration of graph.sinkRegistrations) {
		if (!process.arrivals.has(registration.registrar)) continue;
		const registrar = graph.functions[registration.registrar];
		for (const callback of registration.callbacks) {
			if (!roots.has(callback)) {
				roots.set(
					callback,
					`registered with ${registration.sink} by ${registrar.name} at ${registrar.file}:${registration.line}`,
				);
			}
		}
	}
	const startupOnly = reviewed(policy.startupOnly, "STARTUP_ONLY");
	for (const id of otherModes.keys()) startupOnly.set(id, "other mode");
	const loadedAtStartup = startupModuleNodes(graph, policy.startupModules, policyErrors);
	const interactive = reach(
		graph,
		roots,
		{
			stopAt: startupOnly,
			followRegistrations: true,
			skipEdge: (_from, to, edge) => edge === "import" && loadedAtStartup.has(to),
		},
		registrations,
	);
	for (const [id] of startupOnly) {
		if (
			!interactive.stoppedFrom.has(id) &&
			policy.startupOnly.some((entry) => byName.get(selectorKey(entry)) === id)
		) {
			policyErrors.push(
				`STARTUP_ONLY: ${describe(graph.functions[id])} is no longer reached from an interactive root`,
			);
		}
	}

	const ownerOf = (file: string) =>
		policy.ownedElsewhere.find((area) =>
			area.paths.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path)),
		)?.owner;
	const findings: Violation[] = [];
	for (const [id] of interactive.arrivals) {
		const fn = graph.functions[id];
		for (const use of fn.blocking) {
			findings.push({
				file: fn.file,
				line: use.line,
				api: use.api.label,
				category: use.api.category,
				function: fn.name,
				inAsyncFunction: fn.isAsync,
				ownedBy: ownerOf(fn.file),
				path: pathTo(interactive, id).map((step) => describeArrival(graph, step.id, step.arrival)),
			});
		}
	}
	findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
	const violations = findings.filter((finding) => finding.ownedBy === undefined);
	const deferred = findings.filter((finding) => finding.ownedBy !== undefined);
	const regexFindings: RegexFinding[] = [];
	const reviewedRegexUsed = new Set<string>();
	const reviewedRegex = new Map(policy.reviewedRegexes.map((entry) => [`${entry.file}\0${entry.pattern}`, entry]));
	for (const entry of policy.reviewedRegexes) {
		if (entry.reason.trim().length < 20)
			policyErrors.push(`REVIEWED_REGEXES: /${entry.pattern}/ in ${entry.file} needs a reason`);
	}
	for (const [id] of interactive.arrivals) {
		const fn = graph.functions[id];
		if (ownerOf(fn.file) !== undefined) continue;
		for (const use of fn.regexes) {
			let risks: ReturnType<typeof findBacktrackingRisks>;
			try {
				risks = findBacktrackingRisks(use.pattern, use.flags);
			} catch {
				continue;
			}
			if (risks.length === 0) continue;
			const key = `${fn.file}\0${use.pattern}`;
			if (reviewedRegex.has(key)) {
				reviewedRegexUsed.add(key);
				continue;
			}
			for (const risk of risks) {
				regexFindings.push({
					file: fn.file,
					line: use.line,
					pattern: use.pattern,
					flags: use.flags,
					kind: risk.kind,
					reason: risk.reason,
					function: fn.name,
				});
			}
		}
	}
	for (const [key, entry] of reviewedRegex) {
		if (!reviewedRegexUsed.has(key)) {
			policyErrors.push(
				`REVIEWED_REGEXES: /${entry.pattern}/ in ${entry.file} is not flagged on an interactive path`,
			);
		}
	}
	const warnings: string[] = [];
	for (const area of policy.ownedElsewhere) {
		if (!deferred.some((finding) => finding.ownedBy === area.owner)) {
			warnings.push(`OWNED_ELSEWHERE: nothing left for ${area.owner}; remove the entry`);
		}
	}
	return {
		violations,
		deferred,
		regexFindings,
		warnings,
		policyErrors,
		reachableFunctions: interactive.arrivals.size,
		processFunctions: process.arrivals.size,
		interactiveRoots: roots.size,
		graph,
		interactive,
	};
}

export function buildCallGraph(
	policy: EventLoopPolicy = INTERACTIVE_HOST_POLICY,
	tsconfig = ANALYSIS_TSCONFIG,
	repoRoot = REPO_ROOT,
): { graph: CallGraph; close(): void } {
	const opened = openProject(tsconfig, repoRoot);
	try {
		const graph = new CallGraphBuilder(opened.project, {
			repoRoot,
			isAnalyzedFile: policy.isAnalyzedFile,
			sinks: policy.sinks,
			detachedCallbacks: policy.detachedCallbacks,
		}).build();
		return { graph, close: () => opened.close() };
	} catch (error) {
		opened.close();
		throw error;
	}
}

function main(argv: readonly string[]): number {
	const started = performance.now();
	const { graph, close } = buildCallGraph();
	try {
		const report = analyzeEventLoop(graph);
		const explain = argv.indexOf("--explain");
		if (explain !== -1) {
			const target = argv[explain + 1] ?? "";
			const id = indexByName(graph).get(target);
			if (id === undefined) {
				console.error(`No function ${target}`);
				return 2;
			}
			const chain = pathTo(report.interactive, id);
			if (chain.length === 0) console.log(`${target} is not reachable from an interactive entry point.`);
			for (const step of chain) console.log(describeArrival(graph, step.id, step.arrival));
			return 0;
		}
		if (argv.includes("--json")) {
			const { graph: _graph, interactive: _interactive, ...serializable } = report;
			console.log(JSON.stringify(serializable, null, 2));
		} else {
			for (const violation of report.violations) {
				console.log(`${violation.file}:${violation.line} ${violation.api} in ${violation.function}`);
				if (argv.includes("--paths")) for (const step of violation.path) console.log(`    ${step}`);
			}
			if (argv.includes("--deferred")) {
				for (const finding of report.deferred) {
					console.log(
						`${finding.file}:${finding.line} ${finding.api} in ${finding.function} [owned by ${finding.ownedBy}]`,
					);
				}
			}
			for (const finding of report.regexFindings) {
				console.log(
					`${finding.file}:${finding.line} /${finding.pattern}/${finding.flags} backtracks (${finding.kind}) in ${finding.function}: ${finding.reason}`,
				);
			}
			for (const warning of report.warnings) console.log(`warning: ${warning}`);
			for (const error of report.policyErrors) console.log(`policy: ${error}`);
			console.log(
				`event-loop check: ${report.violations.length} blocking call(s), ${report.deferred.length} more owned by open changes, reachable from ${report.interactiveRoots} interactive entry points (${report.reachableFunctions} of ${graph.functions.length} functions reachable, ${report.processFunctions} in the process) in ${((performance.now() - started) / 1000).toFixed(1)} s`,
			);
		}
		const failed = report.violations.length + report.regexFindings.length + report.policyErrors.length;
		return failed > 0 ? 1 : 0;
	} finally {
		close();
	}
}

if (import.meta.main ?? process.argv[1]?.endsWith("check-event-loop.ts")) {
	process.exitCode = main(process.argv.slice(2));
}
