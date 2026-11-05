import type { StageSnapshot } from "../shared/store-types.js";

const workingDirectories = new WeakMap<StageSnapshot, string>();

export function setStageWorkingDirectory(stage: StageSnapshot, cwd: string | undefined): void {
	if (cwd !== undefined) workingDirectories.set(stage, cwd);
}

export function stageWorkingDirectory(stage: StageSnapshot): string | undefined {
	return workingDirectories.get(stage);
}
