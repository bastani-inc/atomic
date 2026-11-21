#!/usr/bin/env node
// Writes dist/startup-stages/: the modules an interactive session loads once the early editor shows, cut into stages
// that load one at a time with a turn of the event loop between them (src/utils/startup-stages.ts), so the early editor
// keeps answering keys while they load. Importing a module runs its whole graph without a turn of the event loop.
//
// Each stage is a module that imports, in order, some modules of the session's graph. Loading the stages one after the
// other and then the session's own entry modules runs every module exactly once and in the order the runtime would run
// them for the entry modules alone. A stage may only import one of this package's own modules, or a third-party module
// one of them imports by name (by that name) where the runtime reaches it from that module, and only where everything
// run since the previous one lies in that module's own graph: then importing it runs what the runtime would have run
// there, and nothing else, whatever version of a third-party package is installed. A module of an import cycle stands
// for the cycle only when it is the module the runtime enters the cycle by.
//
// The build traces the order the runtime runs the modules in and checks that the stages reproduce it; it fails rather
// than write stages that would not.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cliImports, markerPlace, readModule } from "./startup-stages-source.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(packageRoot, "dist");
const distUrl = pathToFileURL(`${dist}/`).href;
const stagesDir = join(dist, "startup-stages");

/**
 * About how much module source the first stage loads; each stage after it loads about twice as much as the one before,
 * up to {@link LARGEST_STAGE_BYTES}. The first stages, while a user is likely to start typing, are small and answer
 * keys soon (within about 80 ms on Windows); the later ones are larger, so that only about fifteen stages, each with
 * its own small cost, load everything, and none keeps a key waiting much longer than the largest group of modules that
 * must load together.
 */
const FIRST_STAGE_BYTES = 48 * 1024;
const LARGEST_STAGE_BYTES = 1024 * 1024;

if (process.argv[2] === "--trace") {
	await trace(process.argv[3]);
	process.exit(0);
}

// Trace in a process of its own, so no module this script loads counts, and with no preload of the user's.
const traceFile = join(dist, "startup-stages.trace.json");
const traced = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--trace", traceFile], {
	cwd: packageRoot,
	stdio: ["ignore", "inherit", "inherit"],
	env: { ...process.env, NODE_OPTIONS: "" },
});
if (traced.status !== 0) throw new Error(`Tracing the startup modules failed with status ${traced.status}`);
const { order, resolutions, formats, loadedBefore, marked, entryUrls } = JSON.parse(readFileSync(traceFile, "utf8"));
rmSync(traceFile);
const stages = planStages(
	order,
	new Map(resolutions),
	new Map(formats),
	new Set(loadedBefore),
	new Set(marked),
	entryUrls,
);
rmSync(stagesDir, { recursive: true, force: true });
mkdirSync(stagesDir, { recursive: true });
for (const [index, stage] of stages.entries())
	writeFileSync(join(stagesDir, `${index}.js`), `${stage.map((specifier) => `import ${JSON.stringify(specifier)};`).join("\n")}\n`);
writeFileSync(join(stagesDir, "stages.json"), `${JSON.stringify({ version: 1, stages: stages.length })}\n`);
console.log(`Wrote ${stages.length} startup stages -> ${relative(packageRoot, stagesDir)}`);

/**
 * Runs the prefix, then the entries as `cli.js` imports them, and records: the order the modules run in (a marker
 * prepended to each one's source), each import's resolution, and each module's format.
 */
async function trace(outFile) {
	const { registerHooks } = await import("node:module");
	const ran = [];
	const resolutions = [];
	const formats = [];
	const loadedBefore = [];
	const marked = [];
	let beforeEntries = true;
	globalThis.__atomicStartupStagesTrace = ran;
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const result = nextResolve(specifier, context);
			if (context.parentURL?.startsWith("file:") && result.url.startsWith("file:"))
				resolutions.push([`${context.parentURL}\0${specifier}`, result.url]);
			return result;
		},
		load(url, context, nextLoad) {
			const result = nextLoad(url, context);
			if (!url.startsWith("file:")) return result;
			formats.push([url, result.format]);
			if (beforeEntries) loadedBefore.push(url);
			if ((result.format !== "module" && result.format !== "commonjs") || result.source == null) return result;
			marked.push(url);
			const source = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");
			const marker = `globalThis.__atomicStartupStagesTrace.push(${JSON.stringify(url)});`;
			const { at, before } = markerPlace(source, result.format);
			return { ...result, source: `${source.slice(0, at)}${before}${marker}${source.slice(at)}` };
		},
	});
	// What `cli.js` imports before the stages, then the entries as it imports them.
	const { before, entries } = cliImports(dist);
	for (const url of before) await import(url);
	ran.length = 0;
	beforeEntries = false;
	const entryUrls = await Promise.all(entries.map(async (url) => (await import(url), import.meta.resolve(url))));
	writeFileSync(outFile, JSON.stringify({ order: ran, resolutions, formats, loadedBefore, marked, entryUrls }));
}

function planStages(order, resolutions, formats, ranBefore, marked, entryUrls) {
	const isOwn = (url) => url.startsWith(distUrl) && url.endsWith(".js");
	const modules = new Map();
	const moduleOf = (url) => {
		if (!modules.has(url)) modules.set(url, readModule(readFileSync(fileURLToPath(url), "utf8")));
		return modules.get(url);
	};
	// Each module's static imports, resolved, in source order; CommonJS modules run their requires themselves.
	const importsOf = new Map();
	/** Third-party modules Atomic's own modules import by name, with the name. */
	const byName = new Map();
	const imports = (url) => {
		let list = importsOf.get(url);
		if (list) return list;
		list = [];
		if (formats.get(url) === "module") {
			for (const specifier of moduleOf(url).specifiers) {
				const target = resolutions.get(`${url}\0${specifier}`);
				if (target === undefined || !/\.(c|m)?js$/.test(target)) continue;
				if (isOwn(url) && !isOwn(target) && !specifier.startsWith(".") && !byName.has(target))
					byName.set(target, specifier);
				list.push(target);
			}
		}
		importsOf.set(url, list);
		return list;
	};

	// The runtime runs each entry's graph depth first, a module after the modules it imports. The entries run in the
	// order the trace saw them finish in.
	const entries = [...entryUrls].sort((a, b) => order.indexOf(a) - order.indexOf(b));
	const ranOrder = [];
	const firstOfOwnGraph = new Map(); // where in ranOrder a module's newly run graph begins
	const position = new Map();
	const parentOf = new Map();
	const visitedAt = new Map();
	const cycleOf = new Map();
	const visited = new Set();
	const onStack = new Set();
	// Tarjan's strongly connected components, for the import cycles.
	const index = new Map();
	const low = new Map();
	const tarjan = [];
	const onTarjan = new Set();
	let visits = 0;
	const visit = (url, parent) => {
		if (visited.has(url) || ranBefore.has(url)) return;
		visited.add(url);
		onStack.add(url);
		parentOf.set(url, parent);
		visitedAt.set(url, visits);
		index.set(url, visits);
		low.set(url, visits);
		visits++;
		tarjan.push(url);
		onTarjan.add(url);
		firstOfOwnGraph.set(url, ranOrder.length);
		for (const target of imports(url)) {
			if (ranBefore.has(target)) {
				// Run before the stages here, but a third-party module that this own module imports by name may not
				// have run then where other versions are installed: it keeps its place, as a module of its own.
				if (isOwn(url) && byName.has(target) && !visited.has(target)) visitRunBefore(target, url);
				continue;
			}
			if (!visited.has(target)) {
				visit(target, url);
				low.set(url, Math.min(low.get(url), low.get(target)));
			} else if (onTarjan.has(target)) low.set(url, Math.min(low.get(url), index.get(target)));
		}
		if (low.get(url) === index.get(url)) {
			const cycle = [];
			let member;
			do {
				member = tarjan.pop();
				onTarjan.delete(member);
				cycle.push(member);
			} while (member !== url);
			for (const each of cycle) cycleOf.set(each, cycle);
		}
		onStack.delete(url);
		position.set(url, ranOrder.length);
		ranOrder.push(url);
	};
	const visitRunBefore = (url, parent) => {
		visited.add(url);
		parentOf.set(url, parent);
		visitedAt.set(url, visits++);
		firstOfOwnGraph.set(url, ranOrder.length);
		position.set(url, ranOrder.length);
		ranOrder.push(url);
	};
	for (const entry of entries) visit(entry, undefined);

	// The runtime ran exactly this order: otherwise the graph read here is not the one it runs, and no stage is safe.
	// Only modules whose source carried the marker are in the trace.
	const tracedOrder = order.filter((url) => visited.has(url));
	const readOrder = ranOrder.filter((url) => marked.has(url) && !ranBefore.has(url));
	const mismatch = tracedOrder.findIndex((url, at) => url !== readOrder[at]);
	if (tracedOrder.length !== readOrder.length || mismatch !== -1)
		throw new Error(`The startup module order read from the imports differs from the traced one at ${mismatch}`);
	for (const url of ranOrder)
		if (!ranBefore.has(url) && formats.get(url) === "module" && moduleOf(url).topLevelAwait)
			throw new Error(`A startup module awaits at its top level, so it cannot load in stages: ${url}`);

	const importable = (url) => {
		// A third-party module only where Atomic's own code reaches it directly: what a third-party module imports can
		// differ in the installed version, and then reach it from elsewhere.
		if (!isOwn(url)) return byName.has(url) && isOwn(parentOf.get(url) ?? "");
		// A module of an import cycle stands for it only if the runtime enters the cycle by it.
		const cycle = cycleOf.get(url);
		return cycle.every((member) => visitedAt.get(url) <= visitedAt.get(member));
	};
	const specifierOf = (url) => (isOwn(url) ? `../${url.slice(distUrl.length)}` : byName.get(url));
	// What each module costs to load: its source and that of every module that ran just before it outside the list.
	const size = (url) => statSync(fileURLToPath(url)).size;
	const costUpTo = [0];
	{
		let pending = 0;
		const inList = new Set(ranOrder);
		const cost = new Map();
		for (const url of order) {
			pending += size(url);
			if (inList.has(url)) {
				cost.set(url, pending);
				pending = 0;
			}
		}
		// A module that carried no marker (CommonJS the runtime reads itself) costs its own source.
		for (const url of ranOrder)
			costUpTo.push(costUpTo[costUpTo.length - 1] + (ranBefore.has(url) ? 0 : (cost.get(url) ?? size(url))));
	}
	const costBetween = (from, to) => costUpTo[to + 1] - costUpTo[from + 1];

	// Walk the run order and fill the stages, each with about twice the budget of the one before: after the last module
	// imported, the next import is the largest importable module whose own graph starts at or before the next module to
	// run and still fits the stage, else the smallest importable one; one that does not fit starts the next stage.
	const stages = [];
	let stage = [];
	let stageCost = 0;
	let budget = FIRST_STAGE_BYTES;
	const closeStage = () => {
		stages.push(stage);
		stage = [];
		stageCost = 0;
		budget = Math.min(2 * budget, LARGEST_STAGE_BYTES);
	};
	let done = -1;
	while (done < ranOrder.length - 1) {
		let pick;
		let pickCost = 0;
		for (let url = ranOrder[done + 1]; url !== undefined; url = parentOf.get(url)) {
			if (!importable(url) || firstOfOwnGraph.get(url) > done + 1) continue;
			const cost = costBetween(done, position.get(url));
			if (pick !== undefined && stageCost + cost > budget) break;
			pick = url;
			pickCost = cost;
		}
		if (pick === undefined) throw new Error(`No module can load the startup module ${ranOrder[done + 1]} in its order`);
		if (stage.length > 0 && stageCost + pickCost > budget) {
			closeStage();
			continue;
		}
		stage.push(specifierOf(pick));
		stageCost += pickCost;
		done = position.get(pick);
		if (stageCost >= budget) closeStage();
	}
	if (stage.length > 0) stages.push(stage);
	return stages;
}
