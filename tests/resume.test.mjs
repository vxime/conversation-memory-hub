import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeOrderId } from '../src/protocol/order-id.mjs';
import { decideResume } from '../src/protocol/resume.mjs';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
const SHA_NEW = 'd1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';

function order(over = {}) {
  const o = {
    protocol: 'ai-supervisor/order/v1',
    task_id: 't1',
    target: { repository: 'o/r', issue_number: 1, pr_number: null, branch: 'feat/x', observed_head_sha: SHA },
    decision: 'ADVANCE',
    evidence: {
      plan_path: 'docs/p.md',
      checkpoint_path: 'tasks/t/checkpoint.json',
      diff_ref: 'https://example.com/diff',
      ci: { head_sha: SHA, required_checks: [{ name: 'validate', status: 'SUCCESS' }] },
    },
    next_action: {
      scope: 'next',
      allowed_operations: ['edit_feature_branch'],
      forbidden_operations: ['merge'],
      required_result: 'commit',
    },
    ...over,
  };
  o.order_id = computeOrderId({ ...o, order_id: 'x' });
  return o;
}

function base(inputOver = {}) {
  return {
    commentRecords: [],
    liveHeadSha: SHA,
    trustedAuthors: ['owner'],
    taskId: 't1',
    ...inputOver,
  };
}

describe('decideResume', () => {
  it('BLOCKED when comments cannot be read (S06)', () => {
    const r = decideResume({ commentRecords: null, liveHeadSha: SHA });
    assert.equal(r.action, 'BLOCKED');
  });
  it('NO_ORDER when no valid order exists', () => {
    const r = decideResume(base());
    assert.equal(r.action, 'NO_ORDER');
  });
  it('ADVANCE passes through allowed/forbidden ops', () => {
    const r = decideResume(base({
      commentRecords: [{ id: 1, author: 'owner', created_at: '2026-01-15T00:00:00Z', order: order() }],
    }));
    assert.equal(r.action, 'ADVANCE');
    assert.deepEqual(r.allowedOperations, ['edit_feature_branch']);
    assert.deepEqual(r.forbiddenOperations, ['merge']);
    assert.ok(r.orderId);
  });
  it('STALE_ORDER when live HEAD moved (S05/S21)', () => {
    const r = decideResume(base({
      commentRecords: [{ id: 1, author: 'owner', created_at: '2026-01-15T00:00:00Z', order: order() }],
      liveHeadSha: SHA_NEW,
    }));
    assert.equal(r.action, 'STALE_ORDER');
  });
  it('BLOCKED on conflicting verdicts for same HEAD (S09)', () => {
    const a = order();
    const b = order({ decision: 'FIX_REQUIRED' });
    // b needs findings to be valid
    b.findings = [{ finding_id: 'F-001', severity: 'MAJOR', observation: 'x', expected: 'y' }];
    b.order_id = computeOrderId({ ...b, order_id: 'x' });
    const r = decideResume(base({
      commentRecords: [
        { id: 1, author: 'owner', created_at: '2026-01-15T00:00:00Z', order: a },
        { id: 2, author: 'owner', created_at: '2026-01-15T00:05:00Z', order: b },
      ],
    }));
    assert.equal(r.action, 'BLOCKED');
  });
  it('AWAIT_APPROVAL stops and names the approval scope', () => {
    const r = decideResume(base({
      commentRecords: [{ id: 1, author: 'owner', created_at: '2026-01-15T00:00:00Z', order: order({ decision: 'AWAIT_APPROVAL' }) }],
    }));
    assert.equal(r.action, 'AWAIT_APPROVAL');
    assert.ok(r.reason.length > 0);
  });
  it('BLOCKED when task_id does not match (S18)', () => {
    const r = decideResume(base({
      commentRecords: [{ id: 1, author: 'owner', created_at: '2026-01-15T00:00:00Z', order: order() }],
      taskId: 'other-task',
    }));
    assert.equal(r.action, 'BLOCKED');
  });
  it('accepts an order that only names an issue channel', () => {
    const o = order();
    o.target = { ...o.target, pr_number: null };
    o.order_id = computeOrderId({ ...o, order_id: 'x' });
    const r = decideResume(base({
      commentRecords: [{ id: 1, author: 'owner', created_at: '2026-01-15T00:00:00Z', order: o }],
    }));
    assert.equal(r.action, 'ADVANCE');
  });
});
