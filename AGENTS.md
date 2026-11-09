# Worker orchestration in this repository

When a task benefits from delegation, the main Codex agent may use its native `spawn_agent` tool for Codex subagents and the `csaw_external_workers` MCP tools for Claude and DeepSeek coding workers. Give each worker a bounded task and a clear expected result. Use separate worktrees or disjoint file scopes for concurrent edits. Wait for external worker results with `wait_worker`, inspect actual file changes and test output, and integrate the results in the main agent before reporting completion.

Native Codex subagents use Codex's normal skills. Claude and DeepSeek workers receive selected Codex skill instructions only when the main agent supplies their absolute `SKILL.md` paths in `spawn_worker.skills`. Pass only skills relevant to the delegated task. The external workers can read supporting files under those selected skill directories. Kirby, bug-bounty-hunting, and codex-attack selections are limited to document and artifact review in external workers; keep live security testing with the main Codex agent.

Use `csaw_external_workers.list_skills` when a selected skill path is not already known. Namespaced plugin entries such as `codex-attack:engagement-scope` include their absolute `SKILL.md` paths in the result.

Claude and DeepSeek workers are actual coding agents with file and command tools. They use their own provider credentials from the environment. Do not paste API keys into task prompts or files.
