// @ts-check
/**
 * The run's durable ownership record. It is written before every provisioning side effect, so a sweeper or a later
 * `sweep.mjs --run-id` can remove what a dead controller created, including the control VNet's untaggable peerings.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {{ kind: string, name: string, scope: string, state: "planned" | "created" | "deleted" }} ManifestEntry
 * @typedef {{ runId: string, resourceGroup: string, expiresAt: string, subscription: string,
 *   control: { resourceGroup: string, vnet: string }, entries: ManifestEntry[], builder?: string }} ManifestData
 */

export class Manifest {
	/**
	 * @param {string} dir
	 * @param {ManifestData} data
	 */
	constructor(dir, data) {
		this.path = join(dir, "manifest.json");
		/** @type {ManifestData} */
		this.data = data;
		this.flush();
	}

	/** @param {string} dir */
	static load(dir) {
		/** @type {ManifestData} */
		const data = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
		return new Manifest(dir, data);
	}

	flush() {
		const temporary = `${this.path}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(this.data, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temporary, this.path);
	}

	/**
	 * Records an intended resource before the command that creates it.
	 * @param {string} kind
	 * @param {string} name
	 * @param {string} scope
	 */
	plan(kind, name, scope) {
		if (!this.data.entries.some((entry) => entry.kind === kind && entry.name === name && entry.scope === scope)) {
			this.data.entries.push({ kind, name, scope, state: "planned" });
			this.flush();
		}
	}

	/**
	 * @param {string} kind
	 * @param {string} name
	 * @param {string} scope
	 * @param {"created" | "deleted"} state
	 */
	mark(kind, name, scope, state) {
		const entry = this.data.entries.find((item) => item.kind === kind && item.name === name && item.scope === scope);
		if (entry !== undefined) entry.state = state;
		this.flush();
	}

	/** @param {string | undefined} slug */
	setBuilder(slug) {
		this.data.builder = slug;
		this.flush();
	}
}
