# Codex Instructions: TrendingAI

@AGENTS.md

<!-- Codex-specific runtime configuration -->

## Codex Invocation & Execution

- **Invocation:** Use `$trendingai` or ask in natural language to "run trendingai", "run the AI trending report", or "render trendingai".
- **Working Directory:** Always execute commands from the repository root.
- **Tools:** Use native Codex file operations (`read_file`, `write_file`) and shell execution (`bash`/`exec`).
- **Inline Synthesis:** When running fresh harvest synthesis stages (Stages 4–7), perform synthesis in this active session context using the prompts in `prompts/*.md` and validate with `bun scripts/validate-synthesis.ts`.
- **Permissions:** Full local permissions are enabled via `.codex/config.toml`.
