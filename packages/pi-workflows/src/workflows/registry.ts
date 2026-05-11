/**
 * Workflow registry — createRegistry().
 * Immutable, chainable, keyed by normalized workflow name.
 *
 * Supported operations: register (upsert), get, has, remove, merge, names, all.
 *
 * cross-ref: v0.x packages/atomic-sdk/src/registry.ts
 *            pi-subagents src/agents/agents.ts (discover/parse)
 */

import type { WorkflowDefinition } from "../shared/types.js";
import { normalizeWorkflowName } from "./identity.js";

export interface WorkflowRegistry {
  /**
   * Register (upsert) a compiled workflow definition.
   * Keyed by the definition's normalizedName; replaces any prior entry with
   * the same key.  Returns a NEW registry — this one is unchanged.
   */
  register(definition: WorkflowDefinition): WorkflowRegistry;
  /**
   * Alias for register — explicit upsert intent.
   * Returns a NEW registry with the definition added/replaced.
   */
  upsert(definition: WorkflowDefinition): WorkflowRegistry;
  /**
   * Return a new registry with all definitions from another registry merged
   * in (other's entries win on collision).
   */
  merge(other: WorkflowRegistry): WorkflowRegistry;
  /**
   * Retrieve a workflow by (raw or normalized) name.
   * Returns undefined when not found.
   */
  get(name: string): WorkflowDefinition | undefined;
  /** Return true when a workflow with the given (raw or normalized) name exists. */
  has(name: string): boolean;
  /**
   * Return a new registry with the named workflow removed.
   * No-op (returns equivalent registry) if the name is not found.
   */
  remove(name: string): WorkflowRegistry;
  /** Return all registered normalized names (insertion-order preserved). */
  names(): string[];
  /** Return all registered workflow definitions (insertion-order preserved). */
  all(): WorkflowDefinition[];
}

// ---------------------------------------------------------------------------
// Internal factory
// ---------------------------------------------------------------------------

/**
 * Construct a registry backed by an ordered Map keyed by normalizedName.
 */
function makeRegistry(store: Map<string, WorkflowDefinition>): WorkflowRegistry {
  return {
    register(definition) {
      const next = new Map(store);
      next.set(definition.normalizedName, definition);
      return makeRegistry(next);
    },

    upsert(definition) {
      return this.register(definition);
    },

    merge(other) {
      const next = new Map(store);
      for (const def of other.all()) {
        next.set(def.normalizedName, def);
      }
      return makeRegistry(next);
    },

    get(name) {
      return store.get(normalizeWorkflowName(name));
    },

    has(name) {
      return store.has(normalizeWorkflowName(name));
    },

    remove(name) {
      const key = normalizeWorkflowName(name);
      if (!store.has(key)) return this;
      const next = new Map(store);
      next.delete(key);
      return makeRegistry(next);
    },

    names() {
      return [...store.keys()];
    },

    all() {
      return [...store.values()];
    },
  };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a new empty (or pre-populated) immutable-style workflow registry.
 *
 * @example
 * const registry = createRegistry()
 *   .register(myWorkflow)
 *   .register(otherWorkflow);
 *
 * registry.get("my-workflow"); // WorkflowDefinition | undefined
 * registry.has("other-workflow"); // true
 */
export function createRegistry(initial: WorkflowDefinition[] = []): WorkflowRegistry {
  const store = new Map<string, WorkflowDefinition>(
    initial.map((d) => [d.normalizedName, d]),
  );
  return makeRegistry(store);
}
