import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { getAgentDir, SettingsManager } from "@bastani/atomic";
import {
	loadStorageAdapter,
	StorageAdapterLoadError,
	StorageConfigError,
	type StorageSelection,
} from "@bastani/atomic/storage";
import { type RunJournalOption, selectRunJournal } from "../durable/journal/resolution.js";
import type { RunJournal } from "../durable/journal/types.js";
import {
	SharedPoolSetupError,
	type SharedPoolSetupProblem,
	selectionLocation,
	sharedPoolProblems,
	WorkerPlacementConfigError,
} from "./placement-errors.js";
import { processContainmentAvailable } from "./public-pool.js";

/**
 * The journal `journal` selects, as a shared pool's setup reads it before anything opens it (#4310). An invalid
 * selection is refused as the `journal` option.
 */
export function sharedJournalSelection(
	journal: RunJournalOption | undefined,
	options: { readonly agentDir: string; readonly cwd?: string },
): StorageSelection | RunJournal {
	try {
		return selectRunJournal({
			agentDir: options.agentDir,
			journal,
			settings:
				journal === undefined
					? SettingsManager.create(options.cwd ?? process.cwd(), options.agentDir).getSettings()
					: undefined,
		});
	} catch (error) {
		if (!(error instanceof StorageConfigError)) throw error;
		throw new WorkerPlacementConfigError("sdk", "journal", "invalid-option", error.reason, { cause: error });
	}
}

/**
 * What `selection` lacks for a pool that every host opens, before anything opens it: a journal selected through a
 * storage adapter, that adapter loadable, and each of its secrets present (#4310).
 */
export async function sharedSelectionProblems(
	selection: StorageSelection | RunJournal,
	agentDir: string,
): Promise<SharedPoolSetupProblem[]> {
	if ("createRun" in selection) return [sharedPoolProblems.sharedJournalRequired("a journal object", undefined)];
	if (selection.kind !== "adapter")
		return [sharedPoolProblems.sharedJournalRequired(`a ${selection.kind} journal`, selectionLocation(selection))];
	const problems: SharedPoolSetupProblem[] = [];
	try {
		await loadStorageAdapter(selection.module, { agentDir, domain: "journal" });
	} catch (error) {
		if (!(error instanceof StorageAdapterLoadError)) throw error;
		problems.push(sharedPoolProblems.adapterUnavailable(selection.module));
	}
	for (const [secret, ref] of Object.entries(selection.secrets ?? {})) {
		if ("env" in ref) {
			if (process.env[ref.env] === undefined) problems.push(sharedPoolProblems.secretUnavailable(secret, ref));
		} else if (
			"file" in ref &&
			!(await readable(isAbsolute(ref.file) ? ref.file : join(dirname(agentDir), ref.file)))
		)
			problems.push(sharedPoolProblems.secretUnavailable(secret, ref));
	}
	return problems;
}

/**
 * Checks, in one pass and before the root's journal opens, what a root with shared placement needs: its journal
 * selected through a storage adapter every host opens, that adapter loadable, its secrets present, and a host that
 * can contain its workers' processes. Every missing piece is reported together in one {@link SharedPoolSetupError}.
 */
export async function checkSharedPlacementSetup(
	journal: RunJournalOption | undefined,
	options: { readonly cwd?: string; readonly agentDir?: string } = {},
): Promise<void> {
	const agentDir = options.agentDir ?? getAgentDir();
	const problems = await sharedSelectionProblems(
		sharedJournalSelection(journal, { agentDir, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) }),
		agentDir,
	);
	if (!(await processContainmentAvailable())) problems.push(sharedPoolProblems.processContainmentUnavailable());
	const [first, ...rest] = problems;
	if (first !== undefined) throw new SharedPoolSetupError("shared-placement", [first, ...rest]);
}

/** Whether this process can read `path`. */
function readable(path: string): Promise<boolean> {
	return access(path, constants.R_OK).then(
		() => true,
		() => false,
	);
}
