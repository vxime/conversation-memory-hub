import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnly } from '../src/github/gh.mjs';

describe('assertReadOnly', () => {
  it('accepts read commands', () => {
    assert.doesNotThrow(() => assertReadOnly(['api', 'repos/o/r/pulls/1']));
    assert.doesNotThrow(() => assertReadOnly(['api', 'repos/o/r/commits/abc/check-runs', '--paginate']));
    assert.doesNotThrow(() => assertReadOnly(['pr', 'view', '1', '--repo', 'o/r', '--json', 'number']));
    assert.doesNotThrow(() => assertReadOnly(['pr', 'checks', '1', '--repo', 'o/r']));
    assert.doesNotThrow(() => assertReadOnly(['pr', 'diff', '1', '--repo', 'o/r']));
    assert.doesNotThrow(() => assertReadOnly(['repo', 'view', 'o/r', '--json', 'name']));
    assert.doesNotThrow(() => assertReadOnly(['issue', 'view', '1', '--repo', 'o/r']));
  });
  it('rejects write subcommands', () => {
    assert.throws(() => assertReadOnly(['pr', 'merge', '1']), /read-only/);
    assert.throws(() => assertReadOnly(['pr', 'comment', '1']), /read-only/);
    assert.throws(() => assertReadOnly(['issue', 'create']), /read-only/);
    assert.throws(() => assertReadOnly(['repo', 'delete', 'o/r']), /read-only/);
  });
  it('rejects non-GET api methods', () => {
    assert.throws(() => assertReadOnly(['api', '--method', 'POST', 'repos/o/r/issues']), /refused/);
    assert.throws(() => assertReadOnly(['api', '-X', 'DELETE', 'repos/o/r/issues/1']), /refused/);
    assert.throws(() => assertReadOnly(['api', '--input', '-', 'repos/o/r/issues']), /refused/);
  });
  it('rejects unknown commands', () => {
    assert.throws(() => assertReadOnly(['auth', 'login']), /read-only/);
    assert.throws(() => assertReadOnly([]), /refused/);
  });
});
