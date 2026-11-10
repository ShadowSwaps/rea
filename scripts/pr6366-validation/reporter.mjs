// Node 24.22.1 custom reporter. No imports of the target or runner helper.
function errorValue(error, depth = 0) {
  if (!error || depth > 5) return error ? { truncated: true } : undefined;
  const value = {};
  for (const key of ['name', 'message', 'code', 'failureType', 'actual', 'expected', 'operator', 'stack']) {
    if (error[key] !== undefined) value[key] = error[key];
  }
  if (error.cause) value.cause = errorValue(error.cause, depth + 1);
  if (error.errors) value.errors = Array.from(error.errors, e => errorValue(e, depth + 1));
  return value;
}

export default async function* report(source) {
  for await (const { type, data } of source) {
    if (type === 'test:pass' || type === 'test:fail') {
      yield JSON.stringify({ type, name: data.name, nesting: data.nesting, file: data.file,
        line: data.line, skip: data.skip, todo: data.todo, kind: data.details?.type,
        error: errorValue(data.details?.error) }) + '\n';
    } else if (type === 'test:summary') {
      yield JSON.stringify({ type, file: data.file, counts: data.counts, success: data.success }) + '\n';
    } else if (['test:stdout', 'test:stderr', 'test:interrupted'].includes(type)) {
      yield JSON.stringify({ type, data }) + '\n';
    }
  }
  yield JSON.stringify({ type: 'end', version: 1 }) + '\n';
}
