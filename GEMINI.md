# Antigravity / Gemini Instructions: TrendingAI

@AGENTS.md

<!-- Antigravity / Gemini CLI runtime configuration -->

## Antigravity Invocation & Execution

- **Invocation:** Use `/trendingai` or ask in natural language to "run trendingai", "generate the AI trending report", or "render trendingai report".
- **Customization Discovery:** Antigravity discovers workspace customizations automatically from `.agents/skills/trendingai/` and rules from `AGENTS.md` and `GEMINI.md`.
- **Tools:** Use native Antigravity tools:
  - `run_command` for terminal commands (`bun ...`)
  - `read_file` / `write_file` / `edit_file` for file operations
  - `ask_question` for interactive input when needed
- **Inline Synthesis:** Perform inline synthesis turn-by-turn during Stages 4–7 using the prompts in `prompts/*.md` directly within the active model session.
- **Reporting:** When the report is written to `out/latest.html`, run `open out/latest.html` and output a summary.
