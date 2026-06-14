---
name: research-codebase
description: Document codebase as-is with research directory for historical context.
---

# Research Codebase

You are tasked with conducting comprehensive research across the codebase to answer user questions by spawning parallel sub-agents and synthesizing their findings.

The user's research question/request is: **$ARGUMENTS**

## Steps to follow after receiving the research query:

<EXTREMELY_IMPORTANT>

- OPTIMIZE the research question using your prompt-engineer skill to refine phrasing and structure for maximum clarity and precision.
- After research is complete and the research artifact(s) are generated, provide an executive summary of the research and path to the research document(s) to the user, and ask if they have any follow-up questions or need clarification.

</EXTREMELY_IMPORTANT>

1. **Read any directly mentioned files first:**
    - If the user mentions specific files (tickets, docs, or other notes), read them FULLY first
    - **IMPORTANT**: Use the `readFile` tool WITHOUT limit/offset parameters to read entire files
    - **CRITICAL**: Read these files yourself in the main context before spawning any sub-tasks
    - This ensures you have full context before decomposing the research

2. **Determine the compatibility posture:**
    - Before decomposing the research request, identify whether this project must preserve backward compatibility for real downstream users.
    - If the user explicitly allows breaking changes, public API changes, cleanup, or says there are no real users/downstream dependencies, set `breaking_changes_allowed: true`.
    - If the user mentions production users, published APIs, downstream consumers, migration safety, or compatibility requirements, set `breaking_changes_allowed: false`.
    - If the posture is not inferable from the request, ask the user once before continuing, using the available structured question tool when possible.
    - Carry this posture into the research plan, every sub-agent prompt, the final research document frontmatter, and the `## Compatibility Context` section.
    - When `breaking_changes_allowed: true`, document existing legacy behavior, compatibility shims, optional flags, and public APIs as current state, not as constraints future specs must preserve unless the user explicitly asks for preservation.
    - When `breaking_changes_allowed: false`, document public APIs, compatibility-sensitive surfaces, downstream callers, migration constraints, and behavior that future work must preserve.

3. **Analyze and decompose the research question:**
    - Break the research question down into composable research areas
    - Take time to ultrathink about the underlying patterns, connections, and architectural implications the user might be seeking
    - Identify specific components, patterns, or concepts to investigate
    - Create a research plan using TodoWrite to track all subtasks
    - Include the compatibility posture in the plan so later synthesis and spec creation inherit the same constraint.
    - Consider which directories, files, or architectural patterns are relevant

4. **Spawn parallel sub-agent tasks:**
    - Create multiple Task agents to research different aspects concurrently
    - We now have specialized agents that know how to do specific research tasks:

    **For codebase research:**
    - Use the **codebase-locator** agent to find WHERE files and components live
    - Use the **codebase-analyzer** agent to understand HOW specific code works (without critiquing it)
    - Use the **codebase-pattern-finder** agent to find examples of existing patterns (without evaluating them)
    - Output directory: `research/docs/` relative to the current working directory
    - Examples:
        - The database logic is found and can be documented in `research/docs/2024-01-10-database-implementation.md`
        - The authentication flow is found and can be documented in `research/docs/2024-01-11-authentication-flow.md`

    **IMPORTANT**: All agents are documentarians, not critics. They will describe what exists without suggesting improvements or identifying issues.

    **For research directory:**
    - Use the **codebase-research-locator** agent to discover what documents exist about the topic
    - Use the **codebase-research-analyzer** agent to extract key insights from specific documents (only the most relevant ones)

    **For online search:**
    - VERY IMPORTANT: In case you discover external libraries as dependencies, use the **codebase-online-researcher** agent for external documentation and resources
        - The agent fetches live web content using the **browser** skill's `browse` CLI (or `npx browse` / `curl`). Instruct it to apply the token-efficient fetch order: (1) try `curl https://<site>/llms.txt` for an AI-friendly index (see [llmstxt.org](https://llmstxt.org/llms.txt)), (2) try `curl <url> -H "Accept: text/markdown"` to get pre-converted Markdown (supported on Cloudflare-hosted docs via [Markdown for Agents](https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/)), (3) fall back to HTML parsing via `browse`
        - Instruct the agent to return LINKS with their findings and INCLUDE those links in the research document
        - The agent should persist reusable source documents under `research/web/<YYYY-MM-DD>-<kebab-case-topic>.md` (with frontmatter noting `source_url`, `fetched_at`, and `fetch_method`) so future research can reuse them without re-fetching
        - Output directory for the synthesized web research artifacts: `research/web/`:

          When you fetch a document that is worth keeping for future sessions (reference docs, API schemas, SDK guides, release notes, troubleshooting writeups, architecture articles), `write` it to `research/web/<YYYY-MM-DD>-<kebab-case-topic>.md` with frontmatter capturing:
          
          ```markdown
          ---
          source_url: <original URL>
          fetched_at: <YYYY-MM-DD>
          fetch_method: read | llms.txt | markdown-accept-header | browser | browse
          topic: <short description>
          ---
          ```

        - Followed by the extracted content (trimmed of nav chrome, ads, and irrelevant boilerplate). This lets future work reuse the lookup without re-fetching. Before fetching anything, quickly `find research/web/` for an existing, recent copy.

        - Examples:
            - If researching `Redis` locks usage, the agent might find relevant usage and create a document `research/web/2024-01-15-redis-locks-usage.md` with internal links to Redis docs and code references (and cache the fetched Redis docs under `research/web/`)
            - If researching `OAuth` flows, the agent might find relevant external articles and create a document `research/web/2024-01-16-oauth-flows.md` with links to those articles

    The key is to use these agents intelligently:
    - Start with locator agents to find what exists
    - Then use analyzer agents on the most promising findings to document how they work
    - Run multiple agents in parallel when they're searching for different things
    - Each agent knows its job - just tell it what you're looking for
    - Don't write detailed prompts about HOW to search - the agents already know
    - Remind agents they are documenting, not evaluating or improving
    - Include `breaking_changes_allowed: true` or `breaking_changes_allowed: false` in each sub-agent prompt so compatibility-sensitive findings are documented with the right posture.

5. **Wait for all sub-agents to complete and synthesize:**
    - IMPORTANT: Wait for ALL sub-agent tasks to complete before proceeding
    - Compile all sub-agent results (both codebase and research findings)
    - Prioritize live codebase findings as primary source of truth
    - Use research findings as supplementary historical context
    - Connect findings across different components
    - Include specific file paths and line numbers for reference
    - Highlight patterns, connections, and architectural decisions
    - Answer the user's research question with concrete evidence
    - **If findings reveal the original question was misframed** (e.g., the system works differently than assumed, or the components don't exist where expected), flag this to the user before finalizing the document. This is valuable signal — don't bury it.

6. **Generate research document:**
    - Follow the directory structure for research documents:

```
research/
├── tickets/
│   ├── YYYY-MM-DD-XXXX-description.md
├── docs/
│   ├── YYYY-MM-DD-topic.md
├── notes/
│   ├── YYYY-MM-DD-meeting.md
├── ...
└──
```

- Naming conventions:
    - YYYY-MM-DD is today's date
    - topic is a brief kebab-case description of the research topic
    - meeting is a brief kebab-case description of the meeting topic
    - XXXX is the ticket number (omit if no ticket)
    - description is a brief kebab-case description of the research topic
    - Examples:
        - With ticket: `2025-01-08-1478-parent-child-tracking.md`
        - Without ticket: `2025-01-08-authentication-flow.md`
- Structure the document with YAML frontmatter followed by content:

    ```markdown
    ---
    date: !`date '+%Y-%m-%d %H:%M:%S %Z'`
    researcher: [Researcher name from thoughts status]
    git_commit: !`git rev-parse --verify HEAD 2>/dev/null || echo "no-commits"`
    branch: !`git branch --show-current 2>/dev/null || git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unborn"`
    repository: !`basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown-repo"`
    topic: "[User's Question/Topic]"
    tags: [research, codebase, relevant-component-names]
    status: complete
    last_updated: !`date '+%Y-%m-%d'`
    last_updated_by: [Researcher name]
    breaking_changes_allowed: [true or false]
    compatibility_context: "[Short explanation of downstream-user/API compatibility posture]"
    ---

    # Research

    ## Research Question

    [Original user query]

    ## Compatibility Context

    [State whether breaking changes are allowed. If true, note that existing compatibility shims, optional flags, legacy APIs, and public APIs are documented as current state rather than preservation constraints. If false, summarize compatibility-sensitive surfaces, downstream users/callers, migration constraints, and behavior future work must preserve.]

    ## Summary

    [High-level documentation of what was found, answering the user's question by describing what exists]

    ## Detailed Findings

    ### [Component/Area 1]

    - Description of what exists ([file.ext:line](link))
    - How it connects to other components
    - Current implementation details (without evaluation)

    ### [Component/Area 2]

    ...

    ## Code References

    - `path/to/file.py:123` - Description of what's there
    - `another/file.ts:45-67` - Description of the code block

    ## Architecture Documentation

    [Current patterns, conventions, and design implementations found in the codebase]

    ## Historical Context (from research/)

    [Relevant insights from research/ directory with references]

    - `research/docs/YYYY-MM-DD-topic.md` - Information about module X
    - `research/notes/YYYY-MM-DD-meeting.md` - Past notes from internal engineering, customer, etc. discussions
    - ...

    ## Related Research

    [Links to other research documents in research/]

    ## Open Questions

    [Any areas that need further investigation]
    ```

7. **Add GitHub permalinks (if applicable):**
    - Check if on main branch or if commit is pushed: `git branch --show-current` and `git status`
    - If on main/master or pushed, generate GitHub permalinks:
        - Get repo info: `gh repo view --json owner,name`
        - Create permalinks: `https://github.com/{owner}/{repo}/blob/{commit}/{file}#L{line}`
    - Replace local file references with permalinks in the document

8. **Present findings:**
    - Present a concise summary of findings to the user
    - Include key file references for easy navigation
    - Ask if they have follow-up questions or need clarification

9. **Handle follow-up questions:**

- If the user has follow-up questions, append to the same research document
- Update the frontmatter fields `last_updated` and `last_updated_by` to reflect the update
- Add `last_updated_note: "Added follow-up research for [brief description]"` to frontmatter
- Add a new section: `## Follow-up Research [timestamp]`
- Spawn new sub-agents as needed for additional investigation
- Continue updating the document and syncing

## Important notes:

- Please DO NOT implement anything in this stage, just create the comprehensive research document
- Always use parallel Task agents to maximize efficiency and minimize context usage
- Always run fresh codebase research - never rely solely on existing research documents
- The `research/` directory provides historical context to supplement live findings
- Focus on finding concrete file paths and line numbers for developer reference
- Research documents should be self-contained with all necessary context
- Each sub-agent prompt should be specific and focused on read-only documentation operations
- Document cross-component connections and how systems interact
- Include temporal context (when the research was conducted)
- Link to GitHub when possible for permanent references
- Keep the main agent focused on synthesis, not deep file reading
- Have sub-agents document examples and usage patterns as they exist
- Explore all of research/ directory, not just research subdirectory
- **CRITICAL**: You and all sub-agents are documentarians, not evaluators
- **REMEMBER**: Document what IS, not what SHOULD BE
- **NO RECOMMENDATIONS**: Only describe the current state of the codebase
- **File reading**: Always read mentioned files FULLY (no limit/offset) before spawning sub-tasks
- **Compatibility posture**: Always determine `breaking_changes_allowed` before decomposing the question. This is a single project/research posture, not a request to add compatibility flags. Use it to document whether old APIs and shims are constraints for future work.
- **Critical ordering**: Follow the numbered steps exactly
    - ALWAYS read mentioned files first before spawning sub-tasks (step 1)
    - ALWAYS determine compatibility posture before decomposing the question (step 2)
    - ALWAYS wait for all sub-agents to complete before synthesizing (step 5)
    - ALWAYS gather metadata before writing the document (as part of step 6)
    - NEVER write the research document with placeholder values

- **Frontmatter consistency**:
    - Always include frontmatter at the beginning of research documents
    - Keep frontmatter fields consistent across all research documents
    - Update frontmatter when adding follow-up research
    - Use snake_case for multi-word field names (e.g., `last_updated`, `git_commit`)
    - Tags should be relevant to the research topic and components studied

## Final Output

- A collection of research files with comprehensive research findings, properly formatted and linked, ready for consumption to create detailed specifications or design documents.
- IMPORTANT: DO NOT generate any other artifacts or files OUTSIDE of the `research/` directory.
