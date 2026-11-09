import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from './worker.mjs';

test('DeepSeek worker tools can inspect, edit, and run a check', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-worker-'));
  try {
    await tool(cwd, 'write_file', { path: 'answer.txt', content: 'working\n' });
    assert.equal(await tool(cwd, 'read_file', { path: 'answer.txt' }), 'working\n');
    assert.match(await tool(cwd, 'list_directory', { path: '.' }), /answer\.txt/);
    assert.match(await tool(cwd, 'run_command', { command: 'cat answer.txt' }), /^Exit code: 0\nworking\n$/);
    assert.match(await tool(cwd, 'run_command', { command: 'echo broken >&2; exit 7' }), /Exit code: 7\nbroken/);
    assert.equal(await readFile(join(cwd, 'answer.txt'), 'utf8'), 'working\n');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('file tools reject traversal and symlink escapes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-worker-'));
  const outside = await mkdtemp(join(tmpdir(), 'codex-outside-'));
  try {
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(join(outside, 'secret.txt'), join(cwd, 'link.txt'));
    await assert.rejects(tool(cwd, 'read_file', { path: '../escape' }), /escapes workspace/);
    await assert.rejects(tool(cwd, 'read_file', { path: 'link.txt' }), /escapes workspace/);
    await assert.rejects(tool(cwd, 'write_file', { path: 'link.txt', content: 'oops' }), /symlink/);
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside');
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('selected security skill references are readable without command or write access', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-security-review-'));
  const skill = await mkdtemp(join(tmpdir(), 'codex-selected-skill-'));
  try {
    await mkdir(join(skill, 'references'));
    await writeFile(join(skill, 'references', 'methodology.md'), '# Methodology\nReview scope first.\n');
    const roots = [await realpath(skill)];
    const text = await tool(cwd, 'read_file', { path: join(skill, 'references', 'methodology.md') }, undefined, roots, true);
    assert.match(text, /Review scope first/);
    await assert.rejects(tool(cwd, 'run_command', { command: 'echo no' }, undefined, roots, true), /unavailable/);
    await assert.rejects(tool(cwd, 'write_file', { path: 'report.md', content: 'no' }, undefined, roots, true), /unavailable/);
    await assert.rejects(tool(cwd, 'read_file', { path: join(tmpdir(), 'not-selected.txt') }, undefined, roots, true));
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(skill, { recursive: true, force: true });
  }
});
