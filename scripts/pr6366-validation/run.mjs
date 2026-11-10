// FUTURE HOSTED USE ONLY. Local preparation must never execute this file.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, lstat, realpath, mkdir, mkdtemp, copyFile, appendFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare } from './model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = JSON.parse(await readFile(join(here, 'source.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let cancelled = false;
let active;
const terminationErrors = [];
function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (error) { terminationErrors.push({ code: error.code, message: error.message }); }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cancelled = true; if (active) killGroup(active); });

function command(args, cwd) {
  assert.equal(cancelled, false, 'cancelled before source preparation');
  const child = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.equal(child.error, undefined, `git error: ${child.error?.message}`);
  assert.equal(child.signal, null, 'git terminated by signal');
  assert.equal(child.status, 0, `git exited ${child.status}: ${child.stderr}`);
  return child.stdout.trim();
}
async function checkFiles(root, hashes) {
  for (const [path, digest] of Object.entries(hashes)) {
    const file = join(root, source.prototypePath, path);
    const state = await lstat(file);
    assert.ok(state.isFile() && !state.isSymbolicLink(), 'source must be a regular non-linked file');
    assert.equal(sha(await readFile(file)), digest, `source identity: ${path}`);
  }
}
async function execute(directory, name, pattern) {
  if (cancelled) return { stdout: '', stderr: '', exitCode: null, cancelled: true };
  const args = ['--test', '--test-concurrency=1', '--test-timeout=45000',
    `--test-reporter=${join(here, 'reporter.mjs')}`];
  if (pattern) args.push(`--test-name-pattern=${pattern}`);
  args.push(join(directory, source.prototypePath, 'prototype.test.mjs'));
  return await new Promise(resolveRun => {
    const result = { name, args, stdout: '', stderr: '', exitCode: null, signal: null,
      timedOut: false, cancelled: false, truncated: false, spawnError: null };
    const child = spawn(process.execPath, args, { cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    active = child;
    const limit = 1024 * 1024;
    const totals = { stdout: 0, stderr: 0 };
    const chunks = { stdout: [], stderr: [] };
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', data => {
      const remaining = limit - totals[stream];
      totals[stream] += data.length;
      chunks[stream].push(data.subarray(0, Math.max(0, remaining)));
      if (totals[stream] > limit) { result.truncated = true; killGroup(child); }
    });
    const timer = setTimeout(() => { result.timedOut = true; killGroup(child); }, 60000);
    child.on('error', error => { result.spawnError = { code: error.code, message: error.message }; });
    child.on('close', (code, signal) => {
      clearTimeout(timer); active = undefined;
      result.exitCode = code; result.signal = signal; result.cancelled = cancelled;
      result.bytes = totals;
      for (const stream of ['stdout', 'stderr']) result[stream] = Buffer.concat(chunks[stream]).toString('utf8');
      resolveRun(result);
    });
  });
}

let output;
try {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(process.env.GITHUB_REPOSITORY, source.repository);
  assert.equal(process.env.GITHUB_REPOSITORY_ID, source.repositoryId);
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
  assert.equal(process.env.GITHUB_REF, `refs/heads/${source.branch}`);
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1');
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.22.1');
  assert.ok(!process.env.NODE_OPTIONS, 'unexpected NODE_OPTIONS');
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  assert.equal(event.repository.full_name, source.repository);
  assert.equal(String(event.repository.id), source.repositoryId);
  assert.equal(event.repository.visibility, 'public'); assert.equal(event.repository.private, false);
  assert.equal(event.created, true); assert.equal(event.deleted, false); assert.equal(event.forced, false);
  assert.equal(event.after, process.env.GITHUB_SHA);
  const environment = { platform: process.platform, architecture: process.arch, osRelease: release(),
    node: process.version, tmpdir: tmpdir(), canonicalTmpdir: await realpath(tmpdir()), linkedTempAncestors: [],
    tempVariables: Object.fromEntries(['TMPDIR', 'TMP', 'TEMP'].map(k => [k, process.env[k] ?? null])),
    runnerOS: process.env.RUNNER_OS, runnerArch: process.env.RUNNER_ARCH,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, activationCommit: event.after };
  for (let path = tmpdir(); ; path = dirname(path)) {
    if ((await lstat(path)).isSymbolicLink()) environment.linkedTempAncestors.push(path);
    if (dirname(path) === path) break;
  }
  output = { schema: 1, success: false, source, environment, comparison: null, cancelled, terminationErrors,
    cleanup: 'fixture hooks are part of reported tests; no independent resource scan; source copies retire with ephemeral runner' };
  const baseline = resolve(process.argv[2]);
  assert.equal(command(['rev-parse', 'HEAD'], baseline), source.baselineCommit);
  assert.equal(command(['status', '--porcelain'], baseline), '');
  await checkFiles(baseline, source.baselineHashes);
  const patch = join(here, 'correction.patch');
  assert.equal(sha(await readFile(patch)), source.patchSha256);
  const corrected = await mkdtemp(join(process.env.RUNNER_TEMP, 'pr6366-source-'));
  await mkdir(join(corrected, source.prototypePath), { recursive: true });
  for (const path of Object.keys(source.baselineHashes))
    await copyFile(join(baseline, source.prototypePath, path), join(corrected, source.prototypePath, path));
  command(['apply', '--no-index', '--check', patch], corrected);
  command(['apply', '--no-index', patch], corrected);
  await checkFiles(corrected, source.correctedHashes);
  const patterns = { baseline: source.baselinePattern, focused: source.focusedPattern };
  const comparison = await compare({ environment, identities: source.identities,
    execute: name => execute(name === 'baseline' ? baseline : corrected, name, patterns[name]) });
  output.comparison = comparison;
  await checkFiles(baseline, source.baselineHashes);
  await checkFiles(corrected, source.correctedHashes);
  assert.equal(command(['status', '--porcelain'], baseline), '');
  output.success = comparison.success && !cancelled;
  output.cancelled = cancelled;
  process.exitCode = comparison.success && !cancelled ? 0 : 1;
} catch (error) {
  output = { ...output, schema: 1, success: false, outcome: 'setup-or-integrity-failed', cancelled, terminationErrors,
    error: { name: error.name, code: error.code, message: error.message, stack: error.stack } };
  process.exitCode = 1;
}
const serialized = JSON.stringify(output, null, 2);
console.log(serialized);
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `PR6366 bounded comparison (exit ${process.exitCode})\n\n\`\`\`json\n${serialized}\n\`\`\`\n`);
