## 1. Relevant external facts

- **Rust receives argv via `std::env::args()` / `args_os()`**. The first element is the executable path but should not be relied on; `args_os()` preserves raw OS strings better for file paths and non-UTF-8 input. Source: Rust std docs for `std::env::args` and `ArgsOs`.
- **`clap` 4 parses flags, values, positional args, and subcommands with explicit precedence rules.** In particular, `--help` / `--version` are built-in unless disabled, subcommands are first-class commands, and parsing stops into a matched subcommand. Source: `clap::Command` docs and `_concepts` docs.
- **`clap` can auto-handle help/version, but `try_get_matches*` returns errors instead of exiting** for help/version display. Source: `clap::Command::try_get_matches_from`.
- **`clap` has a `subcommand_precedence_over_arg` setting** for cases where an option with multiple values could otherwise greedily consume a subcommand. Source: `clap::Command` docs / changelog.
- **Builtin `--help`/`--version` behavior is configurable** via `disable_help_flag`, `disable_version_flag`, and custom actions. Source: `clap::Command` docs/changelog.

## 2. Local implications

- Your TS CLI does **manual dispatch before full parsing**:
  1. package commands (`install/remove/update/list`)
  2. config command
  3. global args parse
  4. mode resolution (`interactive` / `print` / `json` / `rpc`)
- The Rust version must preserve that **early command routing** or behavior will diverge.
- `--version`, `--help`, and `--export` are handled **after runtime setup** in current TS code, so the Rust port should confirm whether to keep that timing or intentionally move them earlier.
- Mode dispatch depends on **stdin TTY status**:
  - `--mode rpc` wins
  - `--mode json` wins
  - otherwise `--print` or piped stdin forces print mode
  - else interactive
- `@file` args are accepted in normal modes but **rejected in RPC mode**.
- Unknown long flags are currently collected into `unknownFlags` for extension consumption; short unknown flags become errors. Rust parsing should preserve that asymmetry.
- The parser currently has some **non-clap custom precedence**:
  - `--print` may consume the following token as a message unless it looks like a flag/file arg
  - `--list-models` optionally consumes a search term
  - `--thinking` validates against a fixed set and emits warnings instead of hard-failing
- `process.argv.slice(2)` means the TS CLI ignores argv[0]; Rust should similarly parse only user args.

## 3. Version/API assumptions

- I’m assuming **`clap` 4.x** if you choose it for the Rust rewrite.
- I’m assuming Rust CLI entry uses `std::env::args_os()` (or equivalent) plus explicit skipping of argv[0].
- I’m assuming you want **behavioral parity first**, not a redesign of the CLI contract.

## 4. Unverified or unnecessary research

- I did **not** verify which Rust CLI crate you’ll use (`clap`, `argh`, `bpaf`, custom parser, etc.).
- I did **not** inspect every subcommand branch in `package-manager-cli.ts`; the main parity surface is clear enough for this partition.
- I did **not** research shell-completion or Windows-specific argv quirks beyond what affects basic parsing parity.