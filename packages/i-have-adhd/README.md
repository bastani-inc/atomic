# i-have-adhd

Atomic bundles this first-party extension from [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd). It shapes responses for an ADHD-friendly reading flow: action first, numbered steps, visible progress, and no filler.

## Atomic use

ADHD mode is enabled by default for new sessions. Its rules are injected once as a hidden message and remain active across turns, branches, restarts, and compaction.

- Use `/i-have-adhd on` or `/i-have-adhd off` to set the mode for the session.
- Start a session with `--no-adhd` to disable the default.
- Create `.i-have-adhd-off` in the active agent directory to keep the mode off by default.
- Say `stop adhd mode` or `normal mode` to turn it off and confirm the change.

The saved session setting wins over the default on later resumes. The full rules live in [`skills/i-have-adhd/SKILL.md`](./skills/i-have-adhd/SKILL.md).

## License

MIT. See [`LICENSE`](./LICENSE).
