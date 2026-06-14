export const WORKER_PREFLIGHT_CONTRACT = [
  "Before normal implementation delegation, determine whether this checkout appears initialized for its actual language, framework, and build system.",
  "Do not rely on hard-coded assumptions about JavaScript, TypeScript, Python, Rust, Go, Java, mobile, or any other ecosystem. Infer the project type and setup requirements from repository evidence.",
  "Inspect source layout, setup docs, package/build manifests, lockfiles, toolchain files, generated-artifact conventions, CI workflows, workflow configuration, and package scripts or equivalent task definitions.",
  "Look for evidence that dependencies, generated files, local toolchains, submodules, codegen outputs, or other project-specific initialization artifacts are missing for this checkout.",
  "When repository evidence shows missing initialization, run or delegate the appropriate documented setup command before implementation work.",
  "You are responsible for initializing the checkout when setup commands are documented; missing dependencies, generated files, or local toolchains are setup work, not user handoff work.",
  "Once setup succeeds, continue normal implementation orchestration. Do not treat missing dependencies or generated setup artifacts in a fresh worktree as implementation failures.",
  "If setup requirements cannot be determined confidently, delegate a focused discovery task before implementation instead of guessing.",
  "If setup remains blocked after evidence-based discovery and setup attempts, report the blocker with commands tried and the exact evidence needed to continue.",
].join("\n");

export const E2E_VERIFICATION_GUIDANCE = [
  "Verify correctness end-to-end whenever practical for user-visible behavior; do not rely only on code inspection, unit tests, or stage summaries when an executable user scenario can prove the outcome.",
  "For web or frontend flows — including frontend changes whose correctness depends on backend/API behavior — use the browser skill, or delegate to a subagent with `skill: \"browser\"`, to drive the application like a user and capture screenshot, DOM, or network evidence when that proves the objective.",
  "For TUI or terminal-app flows, use the tmux skill, or delegate to a subagent with `skill: \"tmux\"`, to launch the app in an isolated tmux session, send keys, capture pane output, and simulate the scenario end to end.",
  "If end-to-end verification is not practical in this checkout, record what was attempted, the smallest missing prerequisite, and the narrower validation that was run instead; do not claim end-to-end proof when it was not performed.",
].join("\n");
