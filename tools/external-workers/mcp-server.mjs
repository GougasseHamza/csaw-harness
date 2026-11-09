import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { basename, dirname, relative, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const jobs = new Map();
const server = new McpServer({ name: 'codex-external-workers', version: '0.1.0' });
const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

function configuredSkillRoots(cwd) {
  return [
    { path: resolve(homedir(), '.codex/skills'), source: 'user' },
    { path: resolve(homedir(), '.codex/plugins/cache'), source: 'plugin' },
    { path: resolve(process.cwd(), '.agents/skills'), source: 'project' },
    { path: resolve(process.cwd(), '.codex/skills'), source: 'project' },
    { path: resolve(cwd, '.agents/skills'), source: 'project' },
    { path: resolve(cwd, '.codex/skills'), source: 'project' },
  ];
}

async function discoverSkills(cwd) {
  const found = new Map();
  for (const root of configuredSkillRoots(cwd)) {
    const canonical = await realpath(root.path).catch(() => null);
    if (!canonical) continue;
    const pending = [{ path: canonical, depth: 0 }];
    while (pending.length && found.size < 200) {
      const { path, depth } = pending.pop();
      if (depth > 8) continue;
      for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
        const child = resolve(path, entry.name);
        if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) {
          pending.push({ path: child, depth: depth + 1 });
        } else if (entry.isFile() && entry.name === 'SKILL.md') {
          const contents = await readFile(child, 'utf8').catch(() => '');
          const rawName = contents.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
          const description = contents.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
          if (!rawName) continue;
          const rel = relative(canonical, child).split(sep);
          const plugin = root.source === 'plugin' && rel.length >= 5 ? rel[1] : null;
          const name = plugin && !rawName.includes(':') ? `${plugin}:${rawName}` : rawName;
          if (!found.has(name)) found.set(name, { name, description: description.slice(0, 240), path: child, source: root.source });
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function loadSkills(paths = [], cwd = process.cwd()) {
  const configuredRoots = configuredSkillRoots(cwd).map((root) => root.path);
  const roots = (await Promise.all(configuredRoots.map((root) => realpath(root).catch(() => null)))).filter(Boolean);
  const contents = [];
  const skillRoots = [];
  let securityReviewMode = false;
  for (const supplied of paths) {
    const path = resolve(supplied);
    const actual = await realpath(path);
    const allowed = roots.some((root) => {
      const rel = relative(root, actual);
      return rel !== '..' && !rel.startsWith(`..${sep}`) && rel !== '';
    });
    if (!allowed || basename(actual) !== 'SKILL.md') throw new Error('skill path is not an allowed SKILL.md');
    const content = await readFile(actual, 'utf8');
    if (Buffer.byteLength(content) > 32 * 1024) throw new Error('skill exceeds 32 KiB');
    contents.push(`Skill file: ${actual}\n${content}`);
    skillRoots.push(dirname(actual));
    if (actual.includes(`${sep}codex-attack${sep}`)
      || /(?:^|\n)name:\s*(?:kirby|bug-bounty-hunting)\s*(?:\n|$)/.test(content)) {
      securityReviewMode = true;
    }
  }
  return { skillContext: contents.join('\n\n'), skillRoots, securityReviewMode };
}

async function launch({ provider, task, cwd, model, skills }) {
  const id = randomUUID();
  const { skillContext, skillRoots, securityReviewMode } = await loadSkills(skills, cwd);
  const env = { ...process.env };
  if (provider === 'deepseek') {
    env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY || (await readFile(resolve(homedir(), 'key'), 'utf8')).trim();
    if (!env.DEEPSEEK_API_KEY) throw new Error('DeepSeek key is empty');
  } else {
    delete env.DEEPSEEK_API_KEY;
  }
  const child = spawn(process.execPath, [new URL('./worker.mjs', import.meta.url).pathname], {
    cwd: resolve(cwd), env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const job = { id, provider, task, cwd: resolve(cwd), mode: securityReviewMode ? 'security_review' : 'coding', status: 'starting', events: [], child, cancelRequested: false };
  jobs.set(id, job);
  const finish = (status, payload) => {
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return;
    job.status = status;
    job.result = payload;
    child.stdin.end();
  };
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const event = JSON.parse(line);
      if (event.id !== id || event.version !== 1) throw new Error('invalid worker event');
      job.events.push(event);
      if (job.events.length > 200) job.events.shift();
      if (event.type === 'started') job.status = 'running';
      if (event.type === 'result') finish('completed', event.text);
      if (event.type === 'error') finish('failed', event.message);
      if (event.type === 'cancelled') finish('cancelled', event.message);
    } catch (error) {
      finish('failed', `Invalid worker response: ${error.message}`);
    }
  });
  let stderr = '';
  child.stderr.on('data', (bytes) => { stderr = (stderr + bytes.toString()).slice(-4096); });
  child.on('error', (error) => finish('failed', error.message));
  child.on('close', (code) => {
    if (!['completed', 'failed', 'cancelled'].includes(job.status)) {
      finish(job.cancelRequested ? 'cancelled' : 'failed', `Worker exited ${code}: ${stderr}`);
    }
  });
  child.stdin.write(`${JSON.stringify({ version: 1, id, type: 'spawn', provider, task, cwd: job.cwd, model, skillContext, skillRoots, securityReviewMode })}\n`);
  return job;
}

server.registerTool('spawn_worker', {
  description: 'Spawn a real Claude Agent SDK or DeepSeek coding worker in this workspace. The Codex orchestrator can continue work and later collect the result with wait_worker.',
  inputSchema: {
    provider: z.enum(['claude', 'deepseek']),
    task: z.string().min(1),
    cwd: z.string().min(1).describe('Absolute workspace directory'),
    model: z.string().optional(),
    skills: z.array(z.string()).max(4).optional().describe('Absolute paths to relevant Codex SKILL.md files to pass to this worker'),
  },
}, async (args) => {
  const job = await launch(args);
  return result({ id: job.id, provider: job.provider, mode: job.mode, status: job.status });
});

server.registerTool('wait_worker', {
  description: 'Inspect a worker and collect its progress or final result. Poll again if it is still running.',
  inputSchema: { id: z.string(), after: z.number().int().min(0).default(0) },
  annotations: { readOnlyHint: true },
}, async ({ id, after }) => {
  const job = jobs.get(id);
  if (!job) return result({ error: 'unknown worker' });
  return result({ id, provider: job.provider, mode: job.mode, status: job.status, events: job.events.slice(after), next: job.events.length, result: job.result });
});

server.registerTool('cancel_worker', {
  description: 'Interrupt a running Claude or DeepSeek worker.',
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  const job = jobs.get(id);
  if (!job) return result({ error: 'unknown worker' });
  if (!['completed', 'failed', 'cancelled'].includes(job.status)) {
    job.cancelRequested = true;
    job.child.stdin.write(`${JSON.stringify({ version: 1, id, type: 'cancel' })}\n`);
    setTimeout(() => job.child.kill('SIGTERM'), 2000).unref();
  }
  return result({ id, status: job.status });
});

server.registerTool('list_workers', {
  description: 'List Claude and DeepSeek workers started by this Codex session.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => result([...jobs.values()].map(({ id, provider, mode, status }) => ({ id, provider, mode, status }))));

server.registerTool('list_skills', {
  description: 'List available Codex skills with names, descriptions, and validated SKILL.md paths for explicit worker handoff.',
  inputSchema: { cwd: z.string().min(1).describe('Absolute workspace directory') },
  annotations: { readOnlyHint: true },
}, async ({ cwd }) => result(await discoverSkills(cwd)));

await server.connect(new StdioServerTransport());
