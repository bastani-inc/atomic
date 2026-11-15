import type { Component } from "@bastani/atomic-tui";

/**
 * Generic prop-driven component contract. Every renderable owns its own `P` shape;
 * the adapter computes `P` from canonical state via per-component selectors and
 * pushes it via `setProps`. `focused: boolean` is a field on `P` only where the
 * component needs it.
 */
export interface StatefulView<P> extends Component {
	setProps(props: P): void;
}

/**
 * Discriminated focus union — encodes the four-cell focus invariant
 * (`notesVisible`, submit-tab, `chatFocused`, options) that was previously
 * structural-only. Dispatcher cascade (`key-router.ts:151-178`) and reducer's
 * defensive clears (`state-reducer.ts:104-126`) enforce mutual exclusion;
 * this type makes it explicit so per-component `focused: boolean` flags
 * derive from one equality check against this discriminant rather than
 * four parallel boolean reads.
 *
 * Priority order: notes > submit > chat > options. Matches the dispatcher
 * cascade exactly so the union is observably equivalent to today's reads.
 */
export type ActiveView = "notes" | "chat" | "options" | "submit";
