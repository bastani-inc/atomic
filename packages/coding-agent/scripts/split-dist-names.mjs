/**
 * Shared chunk naming, release compatibility re-exports, and startup chunk grouping for `split-dist.mjs`.
 *
 * A shared file is named by the first of the package's own modules it holds, by path, and by the names it exports:
 * not by its content. An install updated in place keeps the name of every shared file whose first module and exports
 * stay the same, so a process still running from the earlier install, which loaded the file under that name, finds in
 * it every name the new code imports from it. A file whose exports change gets another name: such a process loads the
 * new code's copy of it beside the one it holds.
 */
import { createHash } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Eight base-32 characters of the SHA-256 of `key`. */
export function groupName(key) {
	const bytes = createHash("sha256").update(key).digest();
	let name = "";
	for (let index = 0; index < 8; index++) name += BASE32[(bytes[index] ?? 0) % 32];
	return name;
}

/**
 * The name of the shared file `stem` from its metafile entry: its inputs, its exports and, for a file that only
 * re-exports a dynamically imported module and holds no module of its own, that module.
 *
 * @param {string} stem
 * @param {{ inputs: Record<string, unknown>, exports: readonly string[], entryPoint?: string }} meta
 * @param {string} output
 */
export function sharedFileName(stem, meta, output) {
	// The package's own modules first: an inlined dependency's update must not rename a file.
	const inputs = Object.keys(meta.inputs).sort();
	const own = inputs.filter((input) => input.startsWith("dist/"));
	const members = own.length > 0 ? own : inputs;
	const first = members.length > 0 ? `module:${members[0]}` : `entry:${meta.entryPoint ?? output}`;
	return `${stem}-${groupName(`${first}\0${[...meta.exports].sort().join(",")}`)}.js`;
}

/**
 * The files to write so that each shared file `released` names, which a recorded earlier release imports on demand,
 * is still there when this split does not write it: one that re-exports the names that release's file exported from the
 * shared (or compiled thread-entry) file this split writes for the same module (the same stem), which exports every one
 * of them. A process of that release imports such a file by its name, and must find this build's code of that module,
 * not a second copy. Fails, naming the file, when no file of this split, or more than one, can stand for it.
 *
 * @param {readonly { version: string, path: string, names: readonly string[] }[]} released
 * @param {readonly { file: string, stem: string, exports: readonly string[] }[]} outputs
 * @param {string} directory the shared files' directory below `dist`
 * @returns {{ path: string, contents: string }[]}
 */
export function compatSharedFiles(released, outputs, directory) {
	const written = new Set(outputs.map((output) => `${directory}/${output.file}`));
	/** @type {Map<string, { path: string, contents: string }>} */
	const files = new Map();
	for (const { version, path, names } of released) {
		if (written.has(path) || files.has(path)) continue;
		const stem = new RegExp(`^${directory}/([^/]+)-[A-Z2-7]{8}\\.js$`).exec(path)?.[1];
		const candidates = outputs.filter(
			(output) => output.stem === stem && names.every((name) => output.exports.includes(name)),
		);
		if (candidates.length !== 1)
			throw new Error(
				`split-dist: ${version} imports dist/${path} on demand, and ${candidates.length === 0 ? "no" : "more than one"} shared file of this build holds its module with its exports (${names.join(", ")})`,
			);
		const file = path.slice(directory.length + 1);
		const specifier = candidates[0].file.startsWith(".") ? candidates[0].file : `./${candidates[0].file}`;
		files.set(path, {
			path,
			contents: `export { ${[...names].sort().join(", ")} } from ${JSON.stringify(specifier)};\n//# sourceMappingURL=${file}.map\n`,
		});
		files.set(`${path}.map`, {
			path: `${path}.map`,
			contents: `${JSON.stringify({ version: 3, file, sources: [], names: [], mappings: "" })}\n`,
		});
	}
	return [...files.values()];
}

/**
 * Maps a condensed-DAG topological depth inside a given `ownerMask` partition monotonically into compact startup layers
 * so `mainCore` forms ~12-15 balanced (~400-950 KB) acyclic chunks for `write-startup-stages.mjs`.
 * Monotonicity (`d1 <= d2 => bucket(m, d1) <= bucket(m, d2)`) guarantees strictly acyclic inter-layer static edges.
 *
 * @param {number} depth
 * @param {number} [ownerMask]
 * @returns {number}
 */
export function startupDepthBucket(depth, ownerMask = 0) {
	if (ownerMask === 0) {
		if (depth <= 0) return 0;
		if (depth === 1) return 1;
		if (depth === 2) return 2;
		if (depth === 3) return 3;
		if (depth === 4) return 4;
		return 5;
	}
	if (ownerMask === 8) {
		return depth <= 5 ? 0 : 1;
	}
	if (ownerMask === 15) {
		return depth <= 29 ? 0 : 1;
	}
	return 0;
}

/**
 * Partitions bundled non-inline modules into strictly disjoint tiers so startup loads ~15-20 shared files instead of
 * ~130-170 per-entry Venn-diagram shards, while keeping the early-editor path (`elig` and `shell`) ultra-lightweight,
 * preserving acyclic startup-stage layers without `strictExecutionOrder` (`__esmMin`), keeping body-edit/private-leaf
 * filename stability and owner-entry private-leaf containment, and isolating lazy/cold features.
 *
 * @param {readonly string[]} allIds Every bundled module id in the graph.
 * @param {ReadonlySet<string>} inlineEntryIds Entry module ids kept inline in their own entry files (`cli.js` + `OWNER_ENTRIES`).
 * @param {readonly string[]} ownerEntryIds `OWNER_ENTRIES` module ids (external singletons that sit between shared chunks).
 * @param {{
 *   cli: readonly string[],
 *   prewarm: readonly string[],
 *   elig: readonly string[],
 *   shell: readonly string[],
 *   stages: readonly string[],
 *   http: readonly string[],
 *   settingsStartup: readonly string[],
 *   main: readonly string[],
 *   modeInteractive: readonly string[],
 *   modeRpc: readonly string[],
 *   sdk: readonly string[],
 * }} tierRoots
 * @param {(id: string) => readonly string[]} staticDepsOf Static bundled dependencies of `id` (mapping owner externals back to their module id).
 * @returns {Map<string, string>} Map from non-inline module id to its chunk group name (omitted for lazy / owner-private modules).
 */
export function assignStartupGroups(allIds, inlineEntryIds, ownerEntryIds, tierRoots, staticDepsOf) {
	const bundled = new Set(allIds);
	const ownerBit = new Map(ownerEntryIds.map((id, i) => [id, 1 << i]));
	/** @param {readonly string[]} roots */
	const staticReach = (roots) => {
		const seen = new Set();
		const stack = roots.filter((id) => bundled.has(id));
		while (stack.length > 0) {
			const id = /** @type {string} */ (stack.pop());
			if (seen.has(id)) continue;
			seen.add(id);
			for (const dep of staticDepsOf(id)) {
				if (bundled.has(dep) && !seen.has(dep)) stack.push(dep);
			}
		}
		return seen;
	};

	const cliReach = staticReach(tierRoots.cli);
	const prewarmReach = staticReach(tierRoots.prewarm);
	const eligReach = staticReach(tierRoots.elig);
	const shellReach = staticReach(tierRoots.shell);
	const stagesReach = staticReach(tierRoots.stages);
	const httpReach = staticReach(tierRoots.http);
	const settingsStartupReach = staticReach(tierRoots.settingsStartup);
	const mainReach = staticReach(tierRoots.main);
	const interactiveReach = staticReach(tierRoots.modeInteractive);
	const rpcReach = staticReach(tierRoots.modeRpc);
	const sdkReach = staticReach(tierRoots.sdk);

	// Modules imported ONLY by an OWNER_ENTRY (never by any other module in the graph) stay ungrouped so Rolldown
	// bundles them directly inside that owner entry file (preserving owner-entry single-file encapsulation).
	/** @type {Map<string, Set<string>>} */
	const globalImporters = new Map();
	for (const id of allIds) {
		for (const dep of staticDepsOf(id)) {
			if (!bundled.has(dep) || dep === id) continue;
			let set = globalImporters.get(dep);
			if (!set) {
				set = new Set();
				globalImporters.set(dep, set);
			}
			set.add(id);
		}
	}
	const ownerPrivate = new Set();
	for (let changed = true; changed; ) {
		changed = false;
		for (const id of allIds) {
			if (inlineEntryIds.has(id) || ownerPrivate.has(id)) continue;
			const importers = globalImporters.get(id);
			if (!importers || importers.size === 0) continue;
			if ([...importers].every((imp) => ownerBit.has(imp) || ownerPrivate.has(imp))) {
				ownerPrivate.add(id);
				changed = true;
			}
		}
	}

	/** @type {Map<string, string>} */
	const groups = new Map();
	/** @type {Set<string>} */
	const mainCore = new Set();

	for (const id of allIds) {
		if (inlineEntryIds.has(id) || ownerPrivate.has(id)) continue;
		const inCli = cliReach.has(id);
		const inPrewarm = prewarmReach.has(id);
		const inElig = eligReach.has(id);
		const inShell = shellReach.has(id);
		const inStages = stagesReach.has(id);
		const inHttp = httpReach.has(id);
		const inSettingsStartup = settingsStartupReach.has(id);
		const inMain = mainReach.has(id);
		const inInteractive = interactiveReach.has(id);
		const inRpc = rpcReach.has(id);
		const inSdk = sdkReach.has(id);

		// Pre-editor phases P0 (cli) -> P1a (prewarm) -> P1b (elig) -> P2 (shell) -> P3a (stages) and standalone
		// `http-dispatcher` / `settings-startup` stay strictly phase-monotone: no earlier phase ever pulls modules
		// exclusive to a later phase, standalone entries never pull `startup-0-*` or unrelated UI/lockfile code, and
		// an engine child (which loads P0 + P3b, skipping P2 shell) never pulls P2-only shell modules.
		if (inCli) {
			groups.set(id, "p0-cli");
		} else if (inPrewarm && inElig) {
			groups.set(id, "p1-shared");
		} else if (inPrewarm) {
			groups.set(id, "p1a-prewarm");
		} else if (inElig && inShell) {
			// Tiny helpers shared between eligibility and startup-shell, isolated from `p1b-elig`'s lockfile deps so
			// standalone `startup-shell` never pulls `proper-lockfile`.
			groups.set(id, "p1-elig-shell");
		} else if (inElig) {
			groups.set(id, "p1b-elig");
		} else if (inShell && inHttp) {
			// Tiny shared constants (e.g. `core/settings-defaults.js`) used by both `startup-shell` and
			// `http-dispatcher`, kept out of `p2-shell-main` so standalone `http-dispatcher` never pulls TUI/theme.
			groups.set(id, "p2-common");
		} else if (inShell && inMain) {
			// Modules shared by both `startup-shell` and `main` so neither loads anything exclusive to the other.
			groups.set(id, "p2-shell-main");
		} else if (inShell) {
			groups.set(id, "p2-shell");
		} else if (inStages && !inMain && !inHttp && !inSettingsStartup && !inInteractive && !inRpc && !inSdk) {
			groups.set(id, "p3a-stages");
		} else if (inHttp) {
			// `core/http-dispatcher` (+ bundled `undici` when inlined), strictly isolated from `startup-0-*`.
			groups.set(id, "http");
		} else if (inSettingsStartup) {
			// `cli/settings-startup` (~6 tiny error/config helpers + chalk), strictly isolated from `startup-0-*`.
			groups.set(id, "settings-startup");
		} else if (inMain) {
			mainCore.add(id);
		} else if (inInteractive && inRpc) {
			groups.set(id, "mode-shared");
		} else if (inInteractive && inSdk) {
			groups.set(id, "mode-interactive-sdk");
		} else if (inRpc && inSdk) {
			groups.set(id, "mode-rpc-sdk");
		} else if (inInteractive) {
			groups.set(id, "mode-interactive");
		} else if (inRpc) {
			groups.set(id, "mode-rpc");
		} else if (inSdk) {
			groups.set(id, "sdk");
		}
	}

	if (mainCore.size === 0) return groups;

	// Include main-reachable inline entries (such as OWNER_ENTRIES and intermediate SPLIT_ENTRIES) AND owner-private
	// modules in the DAG analysis so every transitive edge through an entry file is seen when computing ownerMask,
	// depths, and private-leaf contraction — guaranteeing zero TDZ cycles and zero synthetic exports on entry files.
	/** @type {Set<string>} */
	const graphNodes = new Set(mainCore);
	for (const entryId of inlineEntryIds) {
		if (mainReach.has(entryId)) graphNodes.add(entryId);
	}
	for (const privId of ownerPrivate) {
		if (mainReach.has(privId)) graphNodes.add(privId);
	}

	// Build induced static subgraph on `graphNodes`.
	/** @type {Map<string, string[]>} */
	const outEdges = new Map();
	/** @type {Map<string, Set<string>>} */
	const inEdges = new Map();
	for (const id of graphNodes) {
		outEdges.set(id, []);
		inEdges.set(id, new Set());
	}
	for (const id of graphNodes) {
		const seenDep = new Set();
		for (const dep of staticDepsOf(id)) {
			if (!graphNodes.has(dep) || dep === id || seenDep.has(dep)) continue;
			seenDep.add(dep);
			outEdges.get(id)?.push(dep);
			inEdges.get(dep)?.add(id);
		}
	}

	// Contract private single-importer leaves into their sole non-entry parent so adding a helper leaf module imported
	// by one existing module never increments any existing module's topological depth or shifts chunk boundaries.
	/** @type {Map<string, string>} */
	const contractedInto = new Map();
	/** @type {Set<string>} */
	const active = new Set(graphNodes);
	for (let changed = true; changed; ) {
		changed = false;
		for (const id of [...active].sort()) {
			if (inlineEntryIds.has(id) || ownerPrivate.has(id)) continue;
			const deps = (outEdges.get(id) ?? []).filter((d) => active.has(d));
			if (deps.length !== 0) continue;
			const parents = [...(inEdges.get(id) ?? [])].filter((p) => active.has(p));
			if (parents.length !== 1 || globalImporters.get(id)?.size !== 1) continue;
			const soleParent = /** @type {string} */ (parents[0]);
			if (inlineEntryIds.has(soleParent) || ownerPrivate.has(soleParent)) continue;
			contractedInto.set(id, soleParent);
			active.delete(id);
			changed = true;
		}
	}

	// Tarjan's strongly connected components on the contracted `active` graph.
	/** @type {Map<string, number>} */
	const indexMap = new Map();
	/** @type {Map<string, number>} */
	const lowlink = new Map();
	/** @type {string[]} */
	const tarjanStack = [];
	/** @type {Set<string>} */
	const onStack = new Set();
	/** @type {string[][]} */
	const sccs = [];
	/** @type {Map<string, number>} */
	const sccOf = new Map();
	let nextIndex = 0;

	/** @param {string} v */
	const strongConnect = (v) => {
		indexMap.set(v, nextIndex);
		lowlink.set(v, nextIndex);
		nextIndex++;
		tarjanStack.push(v);
		onStack.add(v);
		for (const w of (outEdges.get(v) ?? []).filter((d) => active.has(d))) {
			if (!indexMap.has(w)) {
				strongConnect(w);
				lowlink.set(v, Math.min(lowlink.get(v) ?? 0, lowlink.get(w) ?? 0));
			} else if (onStack.has(w)) {
				lowlink.set(v, Math.min(lowlink.get(v) ?? 0, indexMap.get(w) ?? 0));
			}
		}
		if (lowlink.get(v) === indexMap.get(v)) {
			const sccId = sccs.length;
			const members = [];
			while (true) {
				const w = /** @type {string} */ (tarjanStack.pop());
				onStack.delete(w);
				sccOf.set(w, sccId);
				members.push(w);
				if (w === v) break;
			}
			sccs.push(members);
		}
	};

	for (const id of [...active].sort()) {
		if (!indexMap.has(id)) strongConnect(id);
	}

	// Tarjan emits SCCs in reverse topological order: every dependency SCC already has a smaller index than its caller.
	// Compute both topological depth and the bitmask of `OWNER_ENTRIES` reachable from each SCC.
	/** @type {number[]} */
	const sccDepth = new Array(sccs.length).fill(0);
	/** @type {number[]} */
	const sccOwnerMask = new Array(sccs.length).fill(0);
	for (let i = 0; i < sccs.length; i++) {
		let d = 0;
		let mask = 0;
		for (const u of sccs[i] ?? []) {
			mask |= ownerBit.get(u) ?? 0;
			for (const w of outEdges.get(u) ?? []) {
				if (!active.has(w)) continue;
				const depScc = sccOf.get(w);
				if (depScc !== undefined && depScc !== i) {
					d = Math.max(d, (sccDepth[depScc] ?? 0) + 1);
					mask |= sccOwnerMask[depScc] ?? 0;
				}
			}
		}
		sccDepth[i] = d;
		sccOwnerMask[i] = mask;
	}

	for (const id of active) {
		if (!mainCore.has(id)) continue;
		const scc = sccOf.get(id) ?? 0;
		const mask = sccOwnerMask[scc] ?? 0;
		const bucket = startupDepthBucket(sccDepth[scc] ?? 0, mask);
		groups.set(id, `startup-${mask}-${bucket}`);
	}

	// Resolve contracted private leaves to their ancestor's assigned startup layer.
	/** @param {string} id */
	const resolveGroup = (id) => {
		let cur = id;
		while (!groups.has(cur) && contractedInto.has(cur)) {
			cur = /** @type {string} */ (contractedInto.get(cur));
		}
		return groups.get(cur) ?? "startup-0-0";
	};
	for (const id of contractedInto.keys()) {
		groups.set(id, resolveGroup(id));
	}

	return groups;
}
