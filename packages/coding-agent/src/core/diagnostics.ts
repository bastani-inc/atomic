import type { SourceInfo } from "./source-info.ts";

export interface ResourceCollision {
	resourceType: "extension" | "skill" | "prompt" | "theme";
	name: string; // skill name, command/tool/flag name, prompt name, theme name
	winnerPath: string;
	loserPath: string;
	winnerSource?: string; // e.g., "npm:foo", "git:...", "local"
	loserSource?: string;
}

export type OverlappingResourceType = "tool" | "command" | "prompt" | "flag" | "shortcut";

export interface ResourceOverlap {
	resourceType: OverlappingResourceType;
	name: string;
	bundled: SourceInfo;
	inherited: SourceInfo;
}

export interface ResourceDiagnostic {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
	collision?: ResourceCollision;
}
