import { basename } from "node:path";
import type {
	AtomicBuiltin,
	CreateAgentSessionOptions,
	DefaultResourceLoaderInheritanceSnapshot,
	PackageSource,
	SubagentChildPolicy,
} from "@bastani/atomic";
import type { StageSessionRuntime } from "../runs/foreground/stage-runner.js";
import { ConcurrencyLimiter } from "../runs/shared/concurrency.js";
import type { StageStartupPhase } from "../shared/stage-startup.js";

export interface PiSdkSettingsManager {
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
	getBuiltinPackagePaths?: (builtins?: CreateAgentSessionOptions["builtins"]) => string[];
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
	/** Cancellation is cooperative; an active reload keeps its slot until it settles. */
	signal?: AbortSignal;
	onStartupPhase?: (phase: StageStartupPhase) => void;
}
/**
 * Workflow stages are top-level sessions that carry a policy object; they are
 * not subagent children. They keep full management and are authorized to
 * delegate, as `packages/coding-agent/docs/workflows/api-reference.md` documents. Nesting
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

/** Prepare stage sessions with the current agent directory and caller overrides. */
export async function prepareAtomicStageSessionOptions(
	options: CreateAgentSessionOptions | undefined,
	sdk: PiCodingAgentSdk,
	prepareOptions: PrepareAtomicStageSessionOptions = {},
): Promise<AtomicCreateAgentSessionOptions | undefined> {
	prepareOptions.signal?.throwIfAborted();
	prepareOptions.onStartupPhase?.("resource-preparation");
	const atomicOptions = options as AtomicCreateAgentSessionOptions | undefined;
	if (atomicOptions?.resourceLoader !== undefined) return atomicOptions;

	const inheritanceSnapshot = prepareOptions.resourceLoaderInheritanceSnapshot;
	const cwd = resolveSessionCwd(atomicOptions);
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
			? (sdk.getBuiltinPackagePaths?.(atomicOptions?.builtins) ?? [])
			: [...inheritedBuiltinPackagePaths];
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		resourceLoaderInheritanceSnapshot: inheritanceSnapshot,
		builtinPackagePaths: stageBuiltinPackagePaths(builtinPackagePaths, atomicOptions?.builtins),
	});
	await reloadWorkflowStageResources(resourceLoader, prepareOptions);
	prepareOptions.signal?.throwIfAborted();

	return {
		...atomicOptions,
		cwd,
		agentDir,
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
		...(source.mcpServers === undefined ? {} : { mcpServers: [...source.mcpServers] }),
	};
}

function packageSourcePath(source: PackageSource): string {
	return typeof source === "string" ? source : source.source;
}

function disablePackageExtensions(source: PackageSource): PackageSource {
	if (typeof source === "string") return { source, extensions: [] };
	return { ...source, extensions: [] };
}

function stageBuiltinPackagePaths(
	paths: readonly PackageSource[],
	builtins?: CreateAgentSessionOptions["builtins"],
): PackageSource[] {
	// Workflow stages are child AgentSessions owned by the workflow extension.
	// Loading the workflows extension again inside that child session replays its
	// `session_start` lifecycle and clears/kills the parent workflow store. Keep
	// the workflows package itself so its bundled skills/prompts/resources remain
	// available, but disable only its extension entry for stage sessions.
	return paths
		.filter((path) => builtins?.[basename(packageSourcePath(path)) as AtomicBuiltin] !== false)
		.map((path) => {
			const cloned = clonePackageSource(path);
			return basename(packageSourcePath(cloned)) === "workflows" ? disablePackageExtensions(cloned) : cloned;
		});
}

const workflowStageResourceReloads = new ConcurrencyLimiter(4);

async function reloadWorkflowStageResources(
	resourceLoader: PiSdkResourceLoader,
	options: PrepareAtomicStageSessionOptions,
): Promise<void> {
	options.onStartupPhase?.("reload-queued");
	await workflowStageResourceReloads.run(async () => {
		options.signal?.throwIfAborted();
		options.onStartupPhase?.("reload-active");
		await resourceLoader.reload();
	}, options.signal);
}
