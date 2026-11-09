import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('Codex MCP bridge spawns a DeepSeek coding worker and collects its result', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-mcp-worker-'));
  const skillPath = join(cwd, '.agents', 'skills', 'demo', 'SKILL.md');
  await mkdir(join(cwd, '.agents', 'skills', 'demo'), { recursive: true });
  await writeFile(skillPath, '---\nname: demo\ndescription: Test skill\n---\n# Demo skill\nUse the demo-check marker.\n');
  let calls = 0;
  const api = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer test-key');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls++;
    if (calls === 1) assert.match(body.messages[0].content, /demo-check marker/);
    const message = calls === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: 'created by DeepSeek worker\n' }) } }] }
      : { role: 'assistant', content: 'Created result.txt and verified the task.' };
    if (calls === 2) assert.match(JSON.stringify(body.messages), /Wrote result.txt/);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((done) => api.listen(0, '127.0.0.1', done));
  const client = new Client({ name: 'worker-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL('./mcp-server.mjs', import.meta.url).pathname],
    env: { ...process.env, DEEPSEEK_API_KEY: 'test-key', ANTHROPIC_API_KEY: '', DEEPSEEK_API_URL: `http://127.0.0.1:${api.address().port}/chat/completions` },
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'spawn_worker'));
    const catalog = JSON.parse((await client.callTool({ name: 'list_skills', arguments: { cwd } })).content[0].text);
    assert.ok(catalog.some((skill) => skill.name === 'demo' && skill.path.endsWith('/demo/SKILL.md')));
    const spawned = JSON.parse((await client.callTool({ name: 'spawn_worker', arguments: { provider: 'deepseek', task: 'Create result.txt', cwd, skills: [skillPath] } })).content[0].text);
    let observed;
    for (let i = 0; i < 50; i++) {
      observed = JSON.parse((await client.callTool({ name: 'wait_worker', arguments: { id: spawned.id } })).content[0].text);
      if (observed.status === 'completed') break;
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.equal(observed.status, 'completed', JSON.stringify(observed));
    assert.match(observed.result, /result.txt/);
    assert.equal(await readFile(join(cwd, 'result.txt'), 'utf8'), 'created by DeepSeek worker\n');
    assert.equal(calls, 2);
  } finally {
    await client.close();
    await new Promise((done) => api.close(done));
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Codex MCP bridge cancels a running worker', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-mcp-cancel-'));
  const api = createServer((request, response) => {
    request.on('close', () => response.end());
  });
  await new Promise((done) => api.listen(0, '127.0.0.1', done));
  const client = new Client({ name: 'worker-cancel-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL('./mcp-server.mjs', import.meta.url).pathname],
    env: { ...process.env, DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_URL: `http://127.0.0.1:${api.address().port}/chat/completions` },
  });
  try {
    await client.connect(transport);
    const spawned = JSON.parse((await client.callTool({ name: 'spawn_worker', arguments: { provider: 'deepseek', task: 'Wait for API', cwd } })).content[0].text);
    await client.callTool({ name: 'cancel_worker', arguments: { id: spawned.id } });
    let observed;
    for (let i = 0; i < 100; i++) {
      observed = JSON.parse((await client.callTool({ name: 'wait_worker', arguments: { id: spawned.id } })).content[0].text);
      if (observed.status === 'cancelled') break;
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.equal(observed.status, 'cancelled', JSON.stringify(observed));
  } finally {
    await client.close();
    api.closeAllConnections();
    await new Promise((done) => api.close(done));
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Kirby and codex-attack skills expose references in review mode', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-security-skills-'));
  const kirby = join(cwd, '.agents', 'skills', 'kirby');
  const attack = join(cwd, '.agents', 'skills', 'codex-attack', 'engagement-scope');
  await mkdir(join(kirby, 'references'), { recursive: true });
  await mkdir(attack, { recursive: true });
  await writeFile(join(kirby, 'SKILL.md'), '---\nname: kirby\ndescription: Scope review\n---\nRead references/methodology.md');
  await writeFile(join(kirby, 'references', 'methodology.md'), '# Safe methodology\n');
  await writeFile(join(attack, 'SKILL.md'), '---\nname: engagement-scope\ndescription: Scope review\n---\n');
  let calls = 0;
  const api = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls++;
    assert.deepEqual(body.tools.map((tool) => tool.function.name), ['read_file', 'list_directory']);
    if (calls === 1) assert.match(body.messages[0].content, /Skill file:.*codex-attack/);
    if (calls === 2) assert.match(JSON.stringify(body.messages), /Safe methodology/);
    const message = calls === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'skill-ref', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: join(kirby, 'references', 'methodology.md') }) } }] }
      : { role: 'assistant', content: 'Read Safe methodology.' };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((done) => api.listen(0, '127.0.0.1', done));
  const client = new Client({ name: 'security-skill-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL('./mcp-server.mjs', import.meta.url).pathname],
    env: { ...process.env, DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_URL: `http://127.0.0.1:${api.address().port}/chat/completions` },
  });
  try {
    await client.connect(transport);
    const spawned = JSON.parse((await client.callTool({ name: 'spawn_worker', arguments: { provider: 'deepseek', task: 'Read selected skill reference', cwd, skills: [join(kirby, 'SKILL.md'), join(attack, 'SKILL.md')] } })).content[0].text);
    assert.equal(spawned.mode, 'security_review');
    let state;
    for (let i = 0; i < 50; i++) {
      state = JSON.parse((await client.callTool({ name: 'wait_worker', arguments: { id: spawned.id } })).content[0].text);
      if (state.status === 'completed') break;
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.equal(state.status, 'completed', JSON.stringify(state));
    assert.match(state.result, /Safe methodology/);
    assert.equal(calls, 2);
  } finally {
    await client.close();
    await new Promise((done) => api.close(done));
    await rm(cwd, { recursive: true, force: true });
  }
});
