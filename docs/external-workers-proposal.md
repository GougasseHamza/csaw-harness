# Codex with Claude and DeepSeek workers

## Goal

Let a Codex coordinator delegate bounded tasks to Claude and DeepSeek workers while preserving Codex's task tracking, workspace boundaries, and approval flow. Claude runs through the Claude Agent SDK. DeepSeek authenticates with `DEEPSEEK_API_KEY` and uses its Chat Completions API.

## Proposed architecture

1. Define a provider-neutral worker contract: `spawn`, `send`, `interrupt`, `wait`, `status`, streamed events, and a final result. Every event carries the Codex task ID and provider ID.
2. Expose external worker lifecycle tools through a local MCP server. Codex keeps its native `spawn_agent` tool for Codex subagents and uses `spawn_worker` for Claude and DeepSeek. The root agent can launch all three kinds of worker and combine their results.
3. Run each external worker in a child process. The process receives a bounded task, workspace path, tool and permission policy, and cancellation signal. It returns structured progress and a result. Never pass the parent conversation wholesale or promote worker output to user instructions.
4. Claude adapter: use `@anthropic-ai/claude-agent-sdk` and map its streamed messages, tools, permissions, and interruption onto the worker contract. Authenticate using the SDK's supported API-key flow.
5. DeepSeek adapter: use `DEEPSEEK_API_KEY` against `https://api.deepseek.com/chat/completions`. Implement a small agent loop with function tools for approved file reads, search, edits, and commands. Map tool calls and results explicitly; do not assume the Codex Responses protocol is compatible.
6. Share Codex's effective workspace and execution policy with both adapters. For concurrent edits, allocate separate worktrees or disjoint write scopes and require Codex to review and integrate changes. Keep credentials in process environments, redact them from logs, and do not forward Codex credentials to workers.

## Integration points in upstream

- The initial integration uses Codex's existing MCP tool surface and leaves native Codex subagents intact. The MCP server is `tools/external-workers/mcp-server.mjs`.
- `tools/external-workers/worker.mjs` hosts the Claude Agent SDK and DeepSeek coding loops behind a versioned newline-delimited JSON protocol.
- If a unified `spawn_agent` experience is needed later, route its provider selection through `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs` and `codex-rs/core/src/agent/api.rs`. That is a larger change because native agent identity, messaging, persistence, and recovery currently assume Codex threads.

## Delivery order and checks

1. Land the worker protocol and a deterministic fake worker. Verify spawn, event ordering, cancellation, errors, and cleanup through the native collaboration tools.
2. Add a DeepSeek coding agent with read, edit, and command tools. Verify a real API call in a disposable test workspace and confirm the key is absent from events and logs.
3. Add a Claude coding agent through the SDK, with its file and command tools and the same lifecycle checks.
4. Enforce the workspace and approval policy for both adapters. Verify parallel workers cannot overwrite each other's changes.
5. Verify a Codex coordinator can spawn both providers in one task, wait for them, and synthesize their results.

## Current constraints

Upstream Codex's model-provider wire protocol is Responses-only; DeepSeek's documented API uses Chat Completions. A separate DeepSeek worker loop avoids an implicit protocol translation. The current machine has Node.js and Codex installed but no `cargo` command, so Rust build verification needs a Rust toolchain before native changes can be validated locally.

The initial Node worker adapter and MCP bridge are in `tools/external-workers/`. Codex can discover the MCP tools after server registration. The external jobs are separate from Codex's native subagent list and their state is lost if the MCP server restarts. The DeepSeek command tool currently runs with the adapter process's OS privileges; a hardened deployment must pass Codex's effective sandbox and approval policy before using it for delegated tasks.

## Sources

- OpenAI Codex harness: https://developers.openai.com/blog/codex-as-a-platform
- Claude Agent SDK quickstart: https://code.claude.com/docs/en/agent-sdk/quickstart
- DeepSeek API quickstart: https://api-docs.deepseek.com/guides/codex
