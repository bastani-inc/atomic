# A.8 Natural-language workflow authoring
# Give Atomic a prose graph contract. It designs and writes a real custom
# workflow, reloads the registry, and reports the project file it created.
Set TypingSpeed 55ms
Type "atomic"
Sleep 500ms
Enter
Sleep 12s
Set TypingSpeed 18ms
Type "Create a reusable Atomic workflow called review-changes. It must accept one required text input named target. Run two independent reviewers in parallel with fresh context: one for correctness, regressions, and missing tests; one for edge cases, maintainability, and hidden risks. Add a synthesis stage that deduplicates overlap and keeps only evidence-backed issues. Return consolidated_review and decision fields. Write the workflow, reload the registry, and tell me its file path. Do not ask follow-up questions."
Sleep 1s
Enter
Sleep 180s
Type "!!sed -n '1,160p' .atomic/workflows/review-changes.ts"
Sleep 1s
Enter
Sleep 12s
