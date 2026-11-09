import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'external-workers-live-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('./mcp-server.mjs', import.meta.url).pathname],
  env: process.env,
});
const cwd = await mkdtemp(join(tmpdir(), 'codex-live-workers-'));
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

async function run(provider) {
  const file = `${provider}.txt`;
  const expected = `${provider}-ok`;
  const job = await call('spawn_worker', {
    provider,
    cwd,
    task: `Create ${file} containing exactly ${expected} using your file tools. Read the file back, then report its path and contents.`,
  });
  if (!job.id) throw new Error(`${provider} did not start: ${JSON.stringify(job)}`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = await call('wait_worker', { id: job.id });
    if (state.status === 'completed') {
      const contents = (await readFile(join(cwd, file), 'utf8')).trim();
      if (contents !== expected) throw new Error(`${provider} wrote unexpected contents`);
      return { provider, status: state.status, file, result: state.result };
    }
    if (state.status === 'failed' || state.status === 'cancelled') {
      throw new Error(`${provider} ${state.status}: ${state.result}`);
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  await call('cancel_worker', { id: job.id });
  throw new Error(`${provider} timed out`);
}

try {
  await client.connect(transport);
  for (const provider of ['deepseek', 'claude']) {
    console.log(JSON.stringify(await run(provider)));
  }
} finally {
  await client.close();
  await rm(cwd, { recursive: true, force: true });
}
