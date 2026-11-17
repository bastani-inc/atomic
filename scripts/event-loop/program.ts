import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API, type Project } from "typescript/unstable/sync";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ANALYSIS_TSCONFIG = join(REPO_ROOT, "scripts", "event-loop", "tsconfig.analysis.json");

export interface OpenedProject {
	readonly project: Project;
	close(): void;
}

/** Starts the TypeScript 7 compiler in a child process and loads `tsconfig` as one program. */
export function openProject(tsconfig = ANALYSIS_TSCONFIG, cwd = REPO_ROOT): OpenedProject {
	const api = new API({ cwd });
	const snapshot = api.updateSnapshot({ openProjects: [tsconfig] });
	const project = snapshot.getProjects()[0];
	if (project === undefined) {
		api.close();
		throw new Error(`TypeScript did not load a project from ${tsconfig}`);
	}
	return { project, close: () => api.close() };
}
