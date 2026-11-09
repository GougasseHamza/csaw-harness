# External coding workers for Codex

The local MCP server lets Codex spawn Claude and DeepSeek coding agents while retaining its native Codex subagents. The main Codex agent can launch workers, continue its own work, wait for worker results, inspect changed files, and combine the outputs.

## Setup

From this repository:

```sh
npm install --prefix tools/external-workers
codex mcp add csaw_external_workers -- node "$PWD/tools/external-workers/mcp-server.mjs"
```

DeepSeek uses `DEEPSEEK_API_KEY` if set. Otherwise the MCP server reads the key from `~/key` when it launches a DeepSeek worker. The key is passed only to that worker process; it is not stored in the repository or sent in tool results. Claude uses the Claude Agent SDK's existing Claude Code login on this machine. Restart Codex after adding the server.

## Tools

- `spawn_worker({provider, task, cwd, model?, skills?})` starts a Claude or DeepSeek worker and returns a job ID. `skills` is an optional list of absolute paths to relevant Codex `SKILL.md` files; the bridge validates and passes their contents to the worker.
- `wait_worker({id, after?})` returns its state, new events, and final result when done.
- `cancel_worker({id})` interrupts a running job.
- `list_workers()` shows external jobs in the current MCP process.
- `list_skills({cwd})` lists discovered Codex skills, including namespaced plugin skills, with paths that can be passed to `spawn_worker.skills`.

Use Codex's native `spawn_agent` for Codex subagents. The external worker tools do not replace it. Each external worker has its own task and agent loop; Codex should inspect its output and file changes before integrating the result.

Native Codex subagents use Codex's normal skill discovery. Claude and DeepSeek do not automatically inherit that catalog. When an external task needs a skill, the main Codex agent should pass the relevant `SKILL.md` paths in `spawn_worker.skills`. The selected main instructions are provided to the worker, and it can read supporting files under the selected skill directories. This includes Kirby, bug-bounty-hunting, and namespaced codex-attack plugin skills.

Security skill selections run in `security_review` mode: external workers may read the workspace and selected skill references, then return analysis to Codex. Their command and file-write tools are unavailable in that mode. The main Codex agent remains responsible for any live security testing. Claude's provider rejected a real SDK document-only check containing Kirby and codex-attack instructions with a `[cyber]` safeguard response; the bridge returns that provider error and does not retry around it. DeepSeek completed document-only checks with Kirby, bug-bounty-hunting, and codex-attack references. Claude completed a harmless selected-skill reference check, confirming that its general skill handoff works.

## Current behavior

Claude uses the official Claude Agent SDK with Read, Glob, Grep, Edit, Write, and Bash tools. DeepSeek uses its Chat Completions API and loops over read, list, write, and command tools until it finishes or reaches the step limit. Both run in the requested workspace. Jobs are kept in MCP server memory, so restarting the server drops their state.

Run `npm test --prefix tools/external-workers` to test the bridge and DeepSeek tool loop with a local mock API. Live provider calls require keys and are not covered by the local mock test.

The bridge was also verified with `codex exec`: Codex discovered `csaw_external_workers.list_workers`, called it, and received an empty list. This proves tool discovery and invocation, but does not prove live Claude or DeepSeek inference.

Live smoke verification succeeded for both providers using `node tools/external-workers/live-smoke.mjs`: each created and read back a file. A full `codex exec` integration run also spawned a native Codex subagent and both external workers, then verified `codex-ok|deepseek-ok|claude-ok`. That unattended run used a scoped `mcp_servers.csaw_external_workers.tools.spawn_worker.approval_mode="approve"` override; the default MCP approval policy may prompt or reject unattended calls.

For this local installation, the user authorized worker OS access. The following tool approvals were added to `~/.codex/config.toml` so unattended Codex turns can launch and cancel workers:

```toml
[mcp_servers.csaw_external_workers.tools.spawn_worker]
approval_mode = "approve"

[mcp_servers.csaw_external_workers.tools.cancel_worker]
approval_mode = "approve"
```

A follow-up `codex exec` turn without a temporary override spawned a DeepSeek worker, waited for it, and verified the exact file contents. These approvals allow workers to run file and shell tools with the OS permissions of their processes.
