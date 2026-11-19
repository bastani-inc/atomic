/** `createAgentSession({ intercom })`: the session's home Intercom group and the other groups it may reach. */
export interface IntercomSessionOptions {
	/** The session's home group. It replaces the group from the environment, Intercom `config.json` and the project. */
	readonly group: string;
	/** Other groups this session may list, send to and ask; missing or empty means none. */
	readonly reachable?: readonly string[];
}

/** `session.intercom`: the session's Intercom policy, which the host can change while the session runs. */
export interface SessionIntercom {
	/** The home group the host set; undefined for a session created without the `intercom` option. */
	readonly group: string | undefined;
	/** The groups the session may reach besides its home. */
	readonly reachable: readonly string[];
	/**
	 * Replace the groups the session may reach. It takes effect from the session's next Intercom call; the promise
	 * settles once the broker holds the new reach, or at once while the session is not connected (or its connection
	 * closes first), in which case it registers with the new reach. Rejects with `IntercomPolicyError` for a session
	 * created without the `intercom` option.
	 */
	setReachable(groups: readonly string[]): Promise<void>;
}

/** Applies a reach change to the session's Intercom connection; registered by the Intercom builtin. */
export type IntercomReachApplier = (reachable: readonly string[]) => Promise<void> | void;

/** The policy as extensions see it on `ExtensionContext.intercomPolicy`. */
export interface IntercomPolicyView {
	/**
	 * The session's home group: the host's `group`, or for a subagent started by a session with a policy, its own
	 * subagent group (falling back to its parent's home group).
	 */
	readonly home: string;
	/** The groups the session may reach besides its home; always empty for a subagent. */
	readonly reachable: readonly string[];
	/** Whether this is the policy of a subagent started by a session with a policy. */
	readonly child: boolean;
	/** The group a subagent of this session gets for a requested group: its home, or a subgroup under it. */
	childGroup(requested: string | undefined): string;
	/** Register the function that applies a reach change to the broker; returns its unregister. */
	onReachableChange(apply: IntercomReachApplier): () => void;
}

/** An invalid `intercom` option or a reach change on a session that has no policy. */
export class IntercomPolicyError extends TypeError {
	constructor(message: string) {
		super(message);
		this.name = "IntercomPolicyError";
	}
}

/** The most groups a session may list as reachable. */
export const MAX_INTERCOM_REACHABLE_GROUPS = 1_000;

const MAX_GROUP_LENGTH = 1_024;
const RESERVED_GROUP_NAMES = ["true", "auto"];

function groupError(value: IntercomSessionOptions["group"], field: string): string | undefined {
	if (typeof value !== "string" || value.trim().length === 0) return `${field} must be a non-empty group name`;
	const group = value.trim();
	if (group.length > MAX_GROUP_LENGTH) return `${field} is longer than ${MAX_GROUP_LENGTH} characters`;
	if (RESERVED_GROUP_NAMES.includes(group.toLowerCase()))
		return `${field} "${group}" is reserved for subagent auto-groups; choose another name`;
	return undefined;
}

function reachableError(reachable: IntercomSessionOptions["reachable"]): string | undefined {
	if (reachable === undefined) return undefined;
	if (!Array.isArray(reachable)) return "intercom.reachable must be an array of group names";
	if (reachable.length > MAX_INTERCOM_REACHABLE_GROUPS)
		return `intercom.reachable lists ${reachable.length} groups, over the limit of ${MAX_INTERCOM_REACHABLE_GROUPS}`;
	for (const group of reachable) {
		const error = groupError(group, "Each intercom.reachable group");
		if (error !== undefined) return error;
	}
	return undefined;
}

function normalizedReachable(home: string, reachable: readonly string[]): string[] {
	const groups: string[] = [];
	for (const entry of reachable) {
		const group = entry.trim();
		if (group !== home && !groups.includes(group)) groups.push(group);
	}
	return groups;
}

function isSubgroupOf(owner: string, group: string): boolean {
	return group.length > owner.length + 1 && group.startsWith(owner) && group.charAt(owner.length) === "/";
}

/**
 * The group a subagent of a session with a policy gets. With none requested it shares the session's home; a requested
 * group is placed under the home unless it is the home or already under it, so a child never lands in one of its
 * parent's reachable groups or in another session's group.
 */
export function confinedIntercomChildGroup(parentHome: string, requested: string | undefined): string {
	const group = requested?.trim() ?? "";
	if (group.length === 0) return parentHome;
	if (group === parentHome || isSubgroupOf(parentHome, group)) return group;
	return `${parentHome}/${group}`;
}

export function validateIntercomSessionOptions(options: IntercomSessionOptions): void {
	if (typeof options !== "object" || options === null) throw new IntercomPolicyError("intercom must be an object");
	const error = groupError(options.group, "intercom.group") ?? reachableError(options.reachable);
	if (error !== undefined) throw new IntercomPolicyError(error);
}

export class SessionIntercomPolicy implements IntercomPolicyView {
	readonly home: string;
	readonly child: boolean;
	private reachableGroups: readonly string[];
	private readonly appliers = new Set<IntercomReachApplier>();

	private constructor(home: string, reachable: readonly string[], child: boolean) {
		this.home = home;
		this.child = child;
		this.reachableGroups = normalizedReachable(home, reachable);
	}

	static fromOptions(options: IntercomSessionOptions): SessionIntercomPolicy {
		validateIntercomSessionOptions(options);
		return new SessionIntercomPolicy(options.group.trim(), options.reachable ?? [], false);
	}

	static forChild(home: string, parent: IntercomPolicyView): SessionIntercomPolicy {
		const group = home.trim();
		const inherited = parent.reachable.find((reachable) => reachable === group || isSubgroupOf(group, reachable));
		if (inherited !== undefined)
			throw new IntercomPolicyError(
				`A subagent can't use group ${group}: its parent reaches ${inherited}, and a child never gains its parent's reachable groups`,
			);
		return new SessionIntercomPolicy(group, [], true);
	}

	get reachable(): readonly string[] {
		return this.reachableGroups;
	}

	childGroup(requested: string | undefined): string {
		return confinedIntercomChildGroup(this.home, requested);
	}

	onReachableChange(apply: IntercomReachApplier): () => void {
		this.appliers.add(apply);
		return () => {
			this.appliers.delete(apply);
		};
	}

	async setReachable(groups: readonly string[]): Promise<void> {
		if (this.child) throw new IntercomPolicyError("A subagent reaches only its own group");
		const error = reachableError(groups);
		if (error !== undefined) throw new IntercomPolicyError(error.replace("intercom.reachable", "reachable"));
		this.reachableGroups = normalizedReachable(this.home, groups);
		const reachable = this.reachableGroups;
		await Promise.all([...this.appliers].map(async (apply) => apply(reachable)));
	}
}

export function sessionIntercomFacade(policy: SessionIntercomPolicy | undefined): SessionIntercom {
	return {
		get group() {
			return policy === undefined || policy.child ? undefined : policy.home;
		},
		get reachable() {
			return policy?.reachable ?? [];
		},
		setReachable(groups) {
			if (policy === undefined || policy.child)
				return Promise.reject(
					new IntercomPolicyError(
						"This session was created without the intercom option, so its Intercom reach cannot change",
					),
				);
			return policy.setReachable(groups);
		},
	};
}
