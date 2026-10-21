import { computeAckId } from '../protocol/order-id.mjs';
import { validateAck } from '../protocol/validate-ack.mjs';

// Builds the Developer ACK for a consumed Order (plan §5, §7 step 7).
// Pure construction + validation; posting uses src/dispatch/post.mjs
// (ACKs are comments too, so the same two gates apply).

export function buildAck({ order, decisionReceived, observedHeadSha, newHeadSha = null, executed = [], refusalReason = null, commentUrl = null }) {
  if (!order || typeof order.order_id !== 'string') {
    throw new Error('buildAck: a valid order with order_id is required');
  }
  const ack = {
    protocol: 'ai-supervisor/ack/v1',
    order_id: order.order_id,
    task_id: order.task_id,
    repository: order.target.repository,
    observed_head_sha: observedHeadSha,
    decision_received: decisionReceived,
    new_head_sha: newHeadSha,
    executed,
    refusal_reason: refusalReason,
    comment_url: commentUrl,
  };
  ack.ack_id = computeAckId({ ...ack, ack_id: 'x' });
  const v = validateAck(ack);
  return { ack, valid: v.valid, errors: v.errors, warnings: v.warnings };
}
