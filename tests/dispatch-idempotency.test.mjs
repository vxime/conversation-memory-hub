import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeOrderId } from '../src/protocol/order-id.mjs';
import { findDuplicateOrder, selectEffectiveOrder, checkStaleness } from '../src/protocol/idempotency.mjs';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
const SHA2 = 'b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';

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

describe('findDuplicateOrder', () => {
  it('reuses an identical order (S07/S08)', () => {
    const o = order();
    const dup = findDuplicateOrder([{ id: 1, author: 'u', created_at: '2026-01-15T00:00:00Z', order: o }], { ...o });
    assert.ok(dup && dup.id === 1);
  });
  it('does not match orders with a different HEAD', () => {
    const o = order();
    const rec = { id: 1, author: 'u', created_at: '2026-01-15T00:00:00Z', order: o };
    assert.equal(findDuplicateOrder([rec], order({ target: { ...o.target, observed_head_sha: SHA2 } })), null);
  });
  it('ignores invalid stored orders', () => {
    const bad = order();
    bad.order_id = 'f'.repeat(64); // tampered
    const rec = { id: 1, author: 'u', created_at: '2026-01-15T00:00:00Z', order: bad };
    assert.equal(findDuplicateOrder([rec], order()), null);
  });
});

describe('selectEffectiveOrder', () => {
  it('returns NONE when nothing is valid', () => {
    assert.equal(selectEffectiveOrder([]).status, 'NONE');
  });
  it('picks newest by server created_at, not array order (S09)', () => {
    const o1 = order();
    const o2 = order({
      findings: [{ finding_id: 'F-001', severity: 'MINOR', observation: 'nit', expected: 'polish' }],
    });
    const records = [
      { id: 2, author: 'u', created_at: '2026-01-15T10:05:00Z', order: o2 },
      { id: 1, author: 'u', created_at: '2026-01-15T10:00:00Z', order: o1 },
    ];
    const sel = selectEffectiveOrder(records);
    assert.equal(sel.status, 'OK');
    assert.equal(sel.record.order.order_id, o2.order_id);
  });
  it('breaks created_at ties by larger comment id', () => {
    const o1 = order();
    const o2 = order({
      findings: [{ finding_id: 'F-001', severity: 'MINOR', observation: 'nit', expected: 'polish' }],
    });
    const records = [
      { id: 1, author: 'u', created_at: '2026-01-15T10:00:00Z', order: o1 },
      { id: 9, author: 'u', created_at: '2026-01-15T10:00:00Z', order: o2 },
    ];
    const sel = selectEffectiveOrder(records);
    assert.equal(sel.record.order.order_id, o2.order_id);
  });
  it('skips invalid orders entirely', () => {
    const bad = order();
    bad.decision = 'MERGE_NOW';
    const good = order();
    const sel = selectEffectiveOrder([
      { id: 1, author: 'u', created_at: '2026-01-15T10:00:00Z', order: bad },
      { id: 2, author: 'u', created_at: '2026-01-15T10:05:00Z', order: good },
    ]);
    assert.equal(sel.status, 'OK');
    assert.equal(sel.record.order.order_id, good.order_id);
  });
});

describe('checkStaleness', () => {
  it('flags a moved HEAD as stale (S05/S21)', () => {
    const st = checkStaleness(order(), SHA2);
    assert.equal(st.stale, true);
  });
  it('accepts a matching HEAD', () => {
    const st = checkStaleness(order(), SHA);
    assert.equal(st.stale, false);
  });
});
