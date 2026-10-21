import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReceipt } from '../src/review/evidence-receipt.mjs';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
const SHA2 = 'b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';

function run(name, status = 'completed', conclusion = 'success') {
  return { name, status, conclusion, html_url: `https://example.com/${name}`, started_at: '2026-01-15T00:00:00Z', completed_at: '2026-01-15T00:01:00Z' };
}

function ev(over = {}) {
  return {
    protocol: 'ai-supervisor/pr-evidence/v1',
    repo: 'o/r', pr_number: 1, collected_at: '2026-01-15T00:00:00Z',
    pr: { number: 1, state: 'OPEN', base_ref: 'main', head_ref: 'feat/x', head_sha: SHA, url: 'https://example.com/pr/1' },
    head_sha_start: SHA, head_sha_end: SHA, head_moved_during_collection: false,
    base_ref: 'main',
    required_checks: ['validate'],
    check_runs: [run('validate')],
    workflow_runs: [],
    comments: [], comment_count: 0,
    sources: [{ kind: 'pr', ref: 'x' }], errors: [], complete: true,
    ...over,
  };
}

describe('buildReceipt', () => {
  it('READY when all required checks PASS on the HEAD', () => {
    const r = buildReceipt(ev(), { taskId: 't1' });
    assert.equal(r.recommendation, 'READY_FOR_REVIEW_DECISION');
    assert.equal(r.observed_head_sha, SHA);
    assert.match(r.receipt_id, /^[0-9a-f]{64}$/);
    assert.equal(r.check_verdicts[0].verdict, 'PASS');
  });
  it('CI_NOT_COMPLETE when a required check is still queued', () => {
    const r = buildReceipt(ev({ check_runs: [run('validate', 'queued', null)] }), { taskId: 't1' });
    assert.equal(r.recommendation, 'CI_NOT_COMPLETE');
    assert.equal(r.check_verdicts[0].verdict, 'PENDING');
  });
  it('CI_NOT_COMPLETE when a required check never ran', () => {
    const r = buildReceipt(ev({ check_runs: [] }), { taskId: 't1' });
    assert.equal(r.recommendation, 'CI_NOT_COMPLETE');
    assert.equal(r.check_verdicts[0].verdict, 'MISSING');
  });
  it('FINDINGS_PRESENT when a required check failed (never ADVANCE from the receipt)', () => {
    const r = buildReceipt(ev({ check_runs: [run('validate', 'completed', 'failure')] }), { taskId: 't1' });
    assert.equal(r.recommendation, 'FINDINGS_PRESENT');
    assert.ok(r.reasons.join(' ').includes('FIX_REQUIRED'));
  });
  it('BLOCKED_MISSING_EVIDENCE when collection had errors', () => {
    const r = buildReceipt(ev({ complete: false, errors: [{ where: 'check_runs', message: 'boom' }] }), { taskId: 't1' });
    assert.equal(r.recommendation, 'BLOCKED_MISSING_EVIDENCE');
  });
  it('BLOCKED_MISSING_EVIDENCE when HEAD moved during collection', () => {
    const r = buildReceipt(ev({ head_sha_end: SHA2, head_moved_during_collection: true }), { taskId: 't1' });
    assert.equal(r.recommendation, 'BLOCKED_MISSING_EVIDENCE');
    assert.equal(r.observed_head_sha, SHA); // receipt stays bound to the reviewed SHA
  });
  it('BLOCKED_MISSING_EVIDENCE when required list is unknown', () => {
    const r = buildReceipt(ev({ required_checks: null }), { taskId: 't1' });
    assert.equal(r.recommendation, 'BLOCKED_MISSING_EVIDENCE');
  });
  it('READY with recorded not-applicable when no checks are required', () => {
    const r = buildReceipt(ev({ required_checks: [] }), { taskId: 't1' });
    assert.equal(r.recommendation, 'READY_FOR_REVIEW_DECISION');
    assert.ok(r.reasons.join(' ').includes('not applicable'));
  });
  it('latest run per name wins', () => {
    const old = { ...run('validate', 'completed', 'failure'), completed_at: '2026-01-15T00:00:00Z' };
    const fresh = { ...run('validate', 'completed', 'success'), completed_at: '2026-01-15T00:02:00Z' };
    const r = buildReceipt(ev({ check_runs: [old, fresh] }), { taskId: 't1' });
    assert.equal(r.check_verdicts[0].verdict, 'PASS');
  });
  it('receipt_id is deterministic and HEAD-bound', () => {
    const a = buildReceipt(ev(), { taskId: 't1' });
    const b = buildReceipt(ev(), { taskId: 't1' });
    assert.equal(a.receipt_id, b.receipt_id);
    const c = buildReceipt(ev({ head_sha_start: SHA2, head_sha_end: SHA2, check_runs: [] }), { taskId: 't1' });
    assert.notEqual(a.receipt_id, c.receipt_id);
  });
  it('detects order/ack header comments without storing bodies', () => {
    const comments = [
      { id: 1, author: 'u', created_at: 't', html_url: 'h', has_order_header: true, has_ack_header: false },
      { id: 2, author: 'u', created_at: 't', html_url: 'h', has_order_header: false, has_ack_header: true },
    ];
    const r = buildReceipt(ev({ comments, comment_count: 2 }), { taskId: 't1' });
    assert.equal(r.comments.order_comments.length, 1);
    assert.equal(r.comments.ack_comments.length, 1);
    assert.ok(!('body' in r.comments.order_comments[0]));
  });
  it('rejects malformed input', () => {
    assert.throws(() => buildReceipt({ protocol: 'nope' }, { taskId: 't1' }), /pr-evidence/);
    assert.throws(() => buildReceipt(ev(), { taskId: '' }), /taskId/);
    assert.throws(() => buildReceipt(ev({ head_sha_start: 'zzz' }), { taskId: 't1' }), /40-char/);
  });
});
