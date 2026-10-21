import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeOrderId } from '../src/protocol/order-id.mjs';
import { verifyAckId } from '../src/protocol/order-id.mjs';
import { buildAck } from '../src/dispatch/ack.mjs';
import { ACK_HEADER, renderAckComment } from '../src/dispatch/dispatch.mjs';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
const SHA2 = 'b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';

function order() {
  const o = {
    protocol: 'ai-supervisor/order/v1',
    task_id: 't1',
    target: { repository: 'o/r', issue_number: null, pr_number: 7, branch: 'feat/x', observed_head_sha: SHA },
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
  };
  o.order_id = computeOrderId({ ...o, order_id: 'x' });
  return o;
}

describe('buildAck', () => {
  it('builds a valid ack with a verifiable ack_id', () => {
    const { ack, valid, errors } = buildAck({
      order: order(),
      decisionReceived: 'ADVANCE',
      observedHeadSha: SHA,
      newHeadSha: SHA2,
      executed: ['did the thing'],
      commentUrl: 'https://example.com/c/1',
    });
    assert.equal(valid, true, JSON.stringify(errors));
    assert.equal(verifyAckId(ack), true);
    const body = renderAckComment(ack);
    assert.ok(body.startsWith(ACK_HEADER));
  });
  it('requires a refusal reason when nothing was executed for STALE_ORDER', () => {
    const r = buildAck({
      order: order(),
      decisionReceived: 'STALE_ORDER',
      observedHeadSha: SHA,
      executed: [],
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === 'MISSING_REFUSAL_REASON'));
  });
  it('accepts a refusal with a reason', () => {
    const r = buildAck({
      order: order(),
      decisionReceived: 'STALE_ORDER',
      observedHeadSha: SHA,
      executed: [],
      refusalReason: 'HEAD moved; stopped without changes.',
    });
    assert.equal(r.valid, true);
  });
  it('throws without an order', () => {
    assert.throws(() => buildAck({ decisionReceived: 'ADVANCE', observedHeadSha: SHA }), /valid order/);
  });
});
