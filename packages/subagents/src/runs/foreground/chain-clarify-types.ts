export type ClarifyMode = "single" | "parallel" | "chain";

export interface BehaviorOverride {
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
	model?: string;
	skills?: string[] | false;
}

export interface ChainClarifyResult {
	confirmed: boolean;
	templates: string[];
	behaviorOverrides: (BehaviorOverride | undefined)[];
	runInBackground?: boolean;
}

export type EditMode = "template" | "output" | "reads" | "model" | "thinking" | "skills";

export interface SkillOption {
	name: string;
	source: string;
	description?: string;
}

export interface NoticeMessage {
	text: string;
	type: "info" | "error";
}
