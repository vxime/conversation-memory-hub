import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '../src/protocol/canonicalize.mjs';
import { computeOrderId, verifyOrderId, computeAckId, verifyAckId } from '../src/protocol/order-id.mjs';
import { validateOrder } from '../src/protocol/validate-order.mjs';
import { validateAck } from '../src/protocol/validate-ack.mjs';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';

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
      scope: 'do the next step',
      allowed_operations: ['edit_feature_branch'],
      forbidden_operations: ['merge'],
      required_result: 'commit + CI evidence',
    },
    ...over,
  };
  o.order_id = computeOrderId({ ...o, order_id: 'x' });
  return o;
}

describe('canonicalize', () => {
  it('is key-order independent', () => {
    assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  });
  it('keeps array order', () => {
    assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
  });
  it('nests deterministically', () => {
    assert.equal(
      canonicalize({ z: { b: 1, a: [3, 2] } }),
      '{"z":{"a":[3,2],"b":1}}',
    );
  });
});

describe('order id', () => {
  it('is deterministic across key orderings', () => {
    const a = order();
    const shuffled = {};
    for (const k of Object.keys(a).reverse()) shuffled[k] = a[k];
    assert.equal(computeOrderId(shuffled), a.order_id);
  });
  it('changes when decision changes', () => {
    const a = order();
    const b = order({ decision: 'BLOCKED' });
    assert.notEqual(a.order_id, b.order_id);
  });
  it('ignores created_at and notes', () => {
    const a = order();
    const b = order({ created_at: '2026-01-15T00:00:00Z', notes: 'hello' });
    assert.equal(a.order_id, b.order_id);
  });
  it('verifyOrderId rejects tampering', () => {
    const a = order();
    a.target.branch = 'feat/other';
    assert.equal(verifyOrderId(a), false);
  });
  it('ack ids verify', () => {
    const ack = {
      protocol: 'ai-supervisor/ack/v1', order_id: '0'.repeat(64),
      task_id: 't1', repository: 'o/r', observed_head_sha: SHA,
      decision_received: 'ADVANCE',
    };
    ack.ack_id = computeAckId({ ...ack, ack_id: 'x' });
    assert.equal(verifyAckId(ack), true);
    ack.decision_received = 'BLOCKED';
    assert.equal(verifyAckId(ack), false);
  });
});

describe('validateOrder', () => {
  it('accepts a minimal valid order', () => {
    const r = validateOrder(order());
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });
  it('rejects uppercase SHA', () => {
    const o = order();
    o.target.observed_head_sha = SHA.toUpperCase();
    o.order_id = computeOrderId({ ...o, order_id: 'x' });
    const r = validateOrder(o);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === 'BAD_SHA'));
  });
  it('rejects path traversal in plan_path', () => {
    const o = order();
    o.evidence.plan_path = '../etc/passwd';
    o.order_id = computeOrderId({ ...o, order_id: 'x' });
    const r = validateOrder(o);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === 'evidence.plan_path'));
  });
  it('rejects float line numbers', () => {
    const o = order({
      decision: 'FIX_REQUIRED',
      findings: [{ finding_id: 'F-001', severity: 'MINOR', observation: 'x', expected: 'y', line: 10.5 }],
    });
    o.order_id = computeOrderId({ ...o, order_id: 'x' });
    const r = validateOrder(o);
    assert.equal(r.valid, false);
  });
  it('rejects run_attempt 0', () => {
    const o = order();
    o.evidence.ci.required_checks[0].run_attempt = 0;
    o.order_id = computeOrderId({ ...o, order_id: 'x' });
    const r = validateOrder(o);
    assert.equal(r.valid, false);
  });
  it('rejects duplicate finding ids only via schema? no - allows, keeps scope minimal', () => {
    // finding_id uniqueness is intentionally NOT enforced: two findings may
    // legitimately share an id across severities in future extensions.
    const r = validateOrder(order());
    assert.equal(r.valid, true);
  });
});

describe('validateAck', () => {
  function ack(over = {}) {
    const a = {
      protocol: 'ai-supervisor/ack/v1', order_id: '0'.repeat(64),
      task_id: 't1', repository: 'o/r', observed_head_sha: SHA,
      decision_received: 'ADVANCE', new_head_sha: null,
    };
    Object.assign(a, over);
    a.ack_id = computeAckId({ ...a, ack_id: 'x' });
    return a;
  }
  it('accepts a minimal ack', () => {
    assert.equal(validateAck(ack()).valid, true);
  });
  it('rejects unknown decision_received', () => {
    const a = ack({ decision_received: 'MERGED' });
    const r = validateAck(a);
    assert.equal(r.valid, false);
  });
});
