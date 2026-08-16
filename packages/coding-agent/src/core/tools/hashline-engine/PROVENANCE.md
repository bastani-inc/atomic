# Hashline engine provenance

The Atomic hashline engine originated from `can1357/oh-my-pi`'s `packages/hashline` at code-origin commit `15b5c1397fc059673e3b0bcbc50b074e6dc1f9d8`. The upstream MIT notice, including the original copyright and permission text, is preserved in [`LICENSE.upstream`](./LICENSE.upstream).

The MIT license was audited against upstream commit `de6b7974a0658e1fae8fac584368a33021ae668f`. That commit is later than the code-origin pin and has a different `packages/hashline` tree, so the engine headers retain `15b5c1397fc059673e3b0bcbc50b074e6dc1f9d8` rather than misrepresenting the source as copied from `de6b797`. The license text is unchanged between the two commits, which makes the `de6b797` audit valid.

## Atomic-maintained deltas

These engine files carry local deltas maintained by Atomic:

- `tokenizer.ts`: rejects line anchors that cannot be represented as positive safe integers before numeric expansion or iteration, and reports the complete typed anchor with its parser line number.
- `format.ts`: defines the 100,000-line expanded-range limit and retains a pure numbered-line formatter; terminal-newline sentinel handling lives in the normal file read path (`../read.ts`) so partial slices and `:raw` reads are not normalized by the formatter.
- `parser.ts`: rejects numeric ranges larger than the limit before expansion and warns while preserving explicit hunk-looking `+TEXT` payloads as literals.
- `messages.ts`: defines the warning emitted for hunk-looking literal payloads.
- `normalize.ts`: retains the pre-existing Atomic parity adaptation.

The deltas listed above are Atomic-authored and were **not copied from upstream at any commit**. The remaining engine files retain their original vendored-origin headers because they are untouched by these maintained deltas.
