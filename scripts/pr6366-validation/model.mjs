// Pure report validation and finite orchestration. Importing this module runs no tests/processes.
import { isDeepStrictEqual } from 'node:util';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const countKeys = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'suites', 'topLevel'];
function errorInfo(error) {
  try { return { name: error instanceof Error ? error.name : 'NonErrorThrown',
    message: error instanceof Error ? error.message : typeof error === 'string' ? error : 'non-Error value' }; }
  catch { return { name: 'UnreadableError', message: 'error details unavailable' }; }
}
function recordShape(record) {
  if (!object(record) || typeof record.type !== 'string') return false;
  if (record.file != null && typeof record.file !== 'string') return false;
  if (record.type === 'test:pass' || record.type === 'test:fail') {
    if (typeof record.name !== 'string' || record.name.length === 0 || !Number.isInteger(record.nesting) || record.nesting < 0) return false;
    if (record.line !== undefined && (!Number.isInteger(record.line) || record.line < 1)) return false;
    if (record.kind !== undefined && typeof record.kind !== 'string') return false;
    for (const key of ['skip', 'todo'])
      if (record[key] !== undefined && typeof record[key] !== 'boolean' && typeof record[key] !== 'string') return false;
    if (record.error !== undefined && !object(record.error)) return false;
    return record.type !== 'test:fail' || object(record.error);
  }
  if (record.type === 'test:summary') return object(record.counts) && typeof record.success === 'boolean' &&
    countKeys.every(k => Number.isInteger(record.counts[k]) && record.counts[k] >= 0);
  if (record.type === 'end') return record.version === 1;
  return false;
}

export function inspectReport(run, expected) {
  const records = [];
  const results = [];
  const observed = { passed: 0, failed: 0 };
  const fail = (reason, classificationError) => ({ valid: false, passing: false, reason,
    observed, results, ...(classificationError ? { classificationError } : {}) });
  try {
    if (!object(run) || typeof run.stdout !== 'string' || typeof run.stderr !== 'string')
      return fail('malformed run envelope');
    let corruption;
    for (const [index, line] of run.stdout.trimEnd().split('\n').entries()) {
      let record;
      try { record = JSON.parse(line); }
      catch { corruption = `invalid/incomplete JSON at record ${index + 1}`; break; }
      if (!recordShape(record)) { corruption = `invalid/unexpected record shape at record ${index + 1}`; break; }
      records.push(record);
      if (record.type === 'test:pass' || record.type === 'test:fail') {
        results.push(record);
        observed[record.type === 'test:pass' ? 'passed' : 'failed']++;
      }
    }
    if (run.timedOut || run.cancelled || run.signal || run.spawnError || run.truncated)
      return fail('process incomplete, cancelled, failed to spawn, signalled or output truncated');
    if (corruption) return fail(corruption);
    if (!run.stdout.endsWith('\n')) return fail('missing final newline');
    if (run.stderr !== '') return fail('unexpected process stderr');
    if (records.at(-1)?.type !== 'end' || records.filter(r => r.type === 'end').length !== 1)
      return fail('missing/duplicate terminal marker');
    if (results.some(r => r.skip || r.todo || r.kind === 'suite')) return fail('skip, todo or suite');
    const identities = results.map(r => ({ name: r.name, nesting: r.nesting }));
    if (!isDeepStrictEqual(identities, expected)) return fail('test identities/order/count differ from frozen source');
    const summaries = records.filter(r => r.type === 'test:summary' && r.file == null);
    if (summaries.length !== 1) return fail('missing/duplicate cumulative summary');
    const { counts, success } = summaries[0];
    const wanted = { tests: expected.length, passed: observed.passed, failed: observed.failed,
      cancelled: 0, skipped: 0, todo: 0, suites: 0, topLevel: expected.filter(t => t.nesting === 0).length };
    if (Object.entries(wanted).some(([k,v]) => counts[k] !== v)) return fail('summary/count mismatch');
    const fileSummaries = records.filter(r => r.type === 'test:summary' && r.file != null);
    if (fileSummaries.length > 1 || fileSummaries.some(r => !isDeepStrictEqual(r.counts, counts) || r.success !== success))
      return fail('single-file/cumulative summaries disagree');
    const passing = observed.failed === 0;
    if (success !== passing || run.exitCode !== (passing ? 0 : 1)) return fail('independent exit/summary mismatch');
    return { valid: true, passing, counts, results, observed };
  } catch (error) { return fail('unexpected report-processing exception', errorInfo(error)); }
}

export function expectedBaselineRefusal(report, environment) {
  if (!report.valid || report.passing || report.results.length !== 1) return false;
  const outer = report.results[0].error;
  const cause = outer?.cause;
  if (outer?.failureType !== 'testCodeFailure' || cause?.code !== 'ERR_ASSERTION' ||
      cause.actual !== false || cause.expected !== true || cause.operator !== 'strictEqual') return false;
  let refusal;
  try { refusal = JSON.parse(cause.message.split('\n')[0]); } catch { return false; }
  if (refusal?.ok !== false || refusal?.error?.tag !== 'unsafe-path') return false;
  return environment.tmpdir !== environment.canonicalTmpdir && environment.linkedTempAncestors.some(
    path => refusal.error.detail === `Unsafe directory: ${path}`);
}

export async function compare({ execute, identities, environment }) {
  const stages = [];
  const failedOutcome = name => name === 'baseline' ? 'baseline-unrelated-or-incomplete' : `corrected-${name}-failed`;
  const failed = (outcome, name) => ({ success: false, outcome, failedStage: name, stages });
  const stage = async name => {
    // Register the stage before processing so even an unexpected classifier exception retains its run.
    const entry = { name, run: null, report: null };
    stages.push(entry);
    try { entry.run = (await execute(name)) ?? null; }
    catch (error) { entry.run = { stdout: '', stderr: '', exitCode: null, spawnError: errorInfo(error) }; }
    entry.report = inspectReport(entry.run, identities[name]);
    return entry.report;
  };
  try {
    const baseline = await stage('baseline');
    if (!baseline.valid) return failed(failedOutcome('baseline'), 'baseline');
    if (baseline.passing) return failed('baseline-not-reproduced', 'baseline');
    if (!expectedBaselineRefusal(baseline, environment)) return failed('baseline-unrelated-failure', 'baseline');
    const focused = await stage('focused');
    if (!focused.valid || !focused.passing) return failed(failedOutcome('focused'), 'focused');
    const full = await stage('full');
    if (!full.valid || !full.passing) return failed(failedOutcome('full'), 'full');
    return { success: true, outcome: 'baseline-refusal-reproduced-and-correction-passed', stages };
  } catch (error) {
    const entry = stages.at(-1);
    // The pure inspector's fallback retains the structurally valid observed prefix even if identity access threw.
    const report = entry.report ?? inspectReport(entry.run, []);
    entry.report = { ...report, valid: false, passing: false,
      reason: 'unexpected comparison-processing exception', classificationError: errorInfo(error) };
    return failed(failedOutcome(entry.name), entry.name);
  }
}
