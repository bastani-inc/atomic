import { basename } from "node:path";
import type {
	CreateAgentSessionOptions,
	DefaultResourceLoaderInheritanceSnapshot,
	PackageSource,
	SubagentChildPolicy,
} from "@bastani/atomic";
import type { StageSessionRuntime } from "../runs/foreground/stage-runner.js";

export interface PiSdkSettingsManager {
	getCodexFastModeSettings(): { readonly chat: boolean; readonly workflow: boolean };
	getRetrySettings?(): { readonly enabled: boolean; readonly maxRetries: number; readonly baseDelayMs: number };
}

export interface PiSdkResourceLoader {
	reload(): Promise<void>;
}

interface PiSdkSessionManager {
	getCwd(): string;
}

export interface PiCodingAgentSdk {
	getAgentDir(): string;
	getBuiltinPackagePaths?: () => string[];
	SettingsManager: {
		create(cwd?: string, agentDir?: string, options?: { projectTrusted?: boolean }): PiSdkSettingsManager;
	};
	DefaultResourceLoader: new (options: {
		cwd: string;
		agentDir: string;
		settingsManager?: PiSdkSettingsManager;
		builtinPackagePaths?: PackageSource[];
		resourceLoaderInheritanceSnapshot?: DefaultResourceLoaderInheritanceSnapshot;
	}) => PiSdkResourceLoader;
	createAgentSession(options?: AtomicCreateAgentSessionOptions): Promise<{ session: StageSessionRuntime }>;
}

export type AtomicCreateAgentSessionOptions = Omit<
	CreateAgentSessionOptions,
	"settingsManager" | "resourceLoader" | "sessionManager"
> & {
	settingsManager?: PiSdkSettingsManager;
	resourceLoader?: PiSdkResourceLoader;
	sessionManager?: PiSdkSessionManager;
};

export interface PrepareAtomicStageSessionOptions {
	resourceLoaderInheritanceSnapshot?: DefaultResourceLoaderInheritanceSnapshot;
	onSettingsManager?: (settingsManager: PiSdkSettingsManager) => void;
}
/**
 * Workflow stages are top-level sessions that carry a policy object; they are
 * not subagent children. They keep full management and are authorized to
 * delegate, as `packages/coding-agent/docs/workflows.md` documents. Nesting
 * stays bounded by the depth guard in the subagent executor.
 */
const WORKFLOW_STAGE_SUBAGENT_POLICY: SubagentChildPolicy = {
	managementActions: "full",
	fanoutAuthorized: true,
	inheritProjectContext: true,
	inheritSkills: true,
};
function resolveSessionCwd(options: AtomicCreateAgentSessionOptions | undefined): string {
	return options?.cwd ?? options?.sessionManager?.getCwd() ?? process.cwd();
}

/**
 * Prepare Atomic SDK stage-session options with Atomic-first resource loading.
 *
 * The Atomic SDK's documented defaults are intentionally significant:
 * omitted `agentDir` means credentials/models/settings can be read from the
 * primary `~/.atomic/agent` paths first while still considering legacy
 * `~/.pi/agent` compatibility paths when the SDK supports multiple config
 * directories. Passing the computed default back as an explicit `agentDir`
 * would accidentally turn that multi-dir behavior into a single-dir override.
 *
 * A user-supplied `agentDir` is still preserved exactly and remains an
 * explicit override. A user-supplied `resourceLoader` is also preserved; in
 * that case cwd/agentDir no longer control resource discovery and only affect
 * session naming/tool path resolution, matching the pi SDK docs.
 */
export async function prepareAtomicStageSessionOptions(
	options: CreateAgentSessionOptions | undefined,
	sdk: PiCodingAgentSdk,
	prepareOptions: PrepareAtomicStageSessionOptions = {},
): Promise<AtomicCreateAgentSessionOptions | undefined> {
	const atomicOptions = options as AtomicCreateAgentSessionOptions | undefined;
	if (atomicOptions?.resourceLoader !== undefined) return atomicOptions;

	const inheritanceSnapshot = prepareOptions.resourceLoaderInheritanceSnapshot;
	const cwd = resolveSessionCwd(atomicOptions);
	const hasAgentDirOverride = atomicOptions?.agentDir !== undefined;
	const agentDir = atomicOptions?.agentDir ?? sdk.getAgentDir();
	const settingsManager =
		atomicOptions?.settingsManager ??
		sdk.SettingsManager.create(
			cwd,
			agentDir,
			inheritanceSnapshot?.projectTrusted === undefined
				? undefined
				: { projectTrusted: inheritanceSnapshot.projectTrusted },
		);
	prepareOptions.onSettingsManager?.(settingsManager);
	const inheritedBuiltinPackagePaths = inheritanceSnapshot?.builtinPackagePaths;
	const builtinPackagePaths =
		inheritedBuiltinPackagePaths === undefined
			? (sdk.getBuiltinPackagePaths?.() ?? [])
			: [...inheritedBuiltinPackagePaths];
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		resourceLoaderInheritanceSnapshot: inheritanceSnapshot,
		builtinPackagePaths: stageBuiltinPackagePaths(builtinPackagePaths),
	});
	await reloadWorkflowStageResources(resourceLoader);

	return {
		...atomicOptions,
		cwd,
		...(hasAgentDirOverride ? { agentDir } : {}),
		settingsManager,
		resourceLoader,
		subagentPolicy: WORKFLOW_STAGE_SUBAGENT_POLICY,
	};
}

function clonePackageSource(source: PackageSource): PackageSource {
	if (typeof source === "string") return source;
	return {
		source: source.source,
		...(source.extensions === undefined ? {} : { extensions: [...source.extensions] }),
		...(source.skills === undefined ? {} : { skills: [...source.skills] }),
		...(source.prompts === undefined ? {} : { prompts: [...source.prompts] }),
		...(source.themes === undefined ? {} : { themes: [...source.themes] }),
		...(source.workflows === undefined ? {} : { workflows: [...source.workflows] }),
	};
}

function packageSourcePath(source: PackageSource): string {
	return typeof source === "string" ? source : source.source;
}

function disablePackageExtensions(source: PackageSource): PackageSource {
	if (typeof source === "string") return { source, extensions: [] };
	return { ...source, extensions: [] };
}

function stageBuiltinPackagePaths(paths: readonly PackageSource[]): PackageSource[] {
	// Workflow stages are child AgentSessions owned by the workflow extension.
	// Loading the workflows extension again inside that child session replays its
	// `session_start` lifecycle and clears/kills the parent workflow store. Keep
	// the workflows package itself so its bundled skills/prompts/resources remain
	// available, but disable only its extension entry for stage sessions.
	return paths.map((path) => {
		const cloned = clonePackageSource(path);
		return basename(packageSourcePath(cloned)) === "workflows" ? disablePackageExtensions(cloned) : cloned;
	});
}

let workflowStageResourceReloadQueue: Promise<void> = Promise.resolve();

async function reloadWorkflowStageResources(resourceLoader: PiSdkResourceLoader): Promise<void> {
	const queuedReload = workflowStageResourceReloadQueue.then(() => resourceLoader.reload());
	workflowStageResourceReloadQueue = queuedReload.catch(() => undefined);
	return queuedReload;
}
