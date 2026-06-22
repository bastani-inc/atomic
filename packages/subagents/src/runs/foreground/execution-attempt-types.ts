import type { CodexFastModeResolvedSettings, CodexFastModeScope } from "@bastani/atomic";
import type { ArtifactPaths } from "../../shared/types.ts";
import type { SingleOutputSnapshot } from "../shared/single-output.ts";

export type RunSingleAttemptShared = {
	sessionEnabled: boolean;
	systemPrompt: string;
	resolvedSkillNames?: string[];
	skillsWarning?: string;
	jsonlPath?: string;
	artifactPaths?: ArtifactPaths;
	attemptNotes: string[];
	outputSnapshot?: SingleOutputSnapshot;
	fastModeSettings: CodexFastModeResolvedSettings;
	fastModeScope: CodexFastModeScope;
	originalTask?: string;
};
