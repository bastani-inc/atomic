import {
	type ProjectTrustOption,
	type ProjectTrustStoreEntry,
	projectTrustOptionsFor,
} from "../../../core/trust-manager.ts";
import { FramedSelector } from "./selector.ts";

export type TrustSelection = Pick<ProjectTrustOption, "trusted" | "updates">;

export interface TrustSelectorOptions {
	cwd: string;
	/** The path a decision about `cwd` is saved under: `getProjectTrustPath(cwd)`. */
	trustPath: string;
	savedDecision: ProjectTrustStoreEntry | null;
	projectTrusted: boolean;
	onSelect: (selection: TrustSelection) => void;
	onCancel: () => void;
}

function formatDecision(trustPath: string, decision: ProjectTrustStoreEntry | null): string {
	if (decision === null) {
		return "none";
	}
	const label = decision.decision ? "trusted" : "untrusted";
	if (decision.path !== trustPath) {
		return `${label} (inherited from ${decision.path})`;
	}
	return `${label} (${decision.path})`;
}

function isSavedOption(option: ProjectTrustOption, savedDecision: ProjectTrustStoreEntry | null): boolean {
	return (
		option.savedPath !== undefined &&
		savedDecision?.decision === option.trusted &&
		savedDecision.path === option.savedPath
	);
}

export class TrustSelectorComponent extends FramedSelector<ProjectTrustOption> {
	constructor(options: TrustSelectorOptions) {
		const trustOptions = projectTrustOptionsFor(options.trustPath);
		const anySaved = trustOptions.some((option) => isSavedOption(option, options.savedDecision));
		super({
			title: "Project trust",
			subtitle: [
				options.cwd,
				`Saved decision: ${formatDecision(options.trustPath, options.savedDecision)}`,
				`Current session: ${options.projectTrusted ? "trusted" : "untrusted"}`,
			].join("\n"),
			numbered: true,
			items: trustOptions.map((option) => {
				const saved = isSavedOption(option, options.savedDecision);
				return {
					id: option.label,
					value: option,
					label: option.label,
					mark: anySaved ? (saved ? "on" : "off") : undefined,
					tag: saved ? "saved" : undefined,
				};
			}),
			maxVisible: trustOptions.length,
			confirmLabel: "save",
			onSelect: (item) => options.onSelect({ trusted: item.value.trusted, updates: item.value.updates }),
			onCancel: options.onCancel,
		});
	}
}
