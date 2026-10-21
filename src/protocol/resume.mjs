import { validateOrder } from './validate-order.mjs';
import { verifyOrderId } from './order-id.mjs';
import { selectEffectiveOrder, checkStaleness } from './idempotency.mjs';

// A-side resume decision (plan §7 steps 3-6, acceptance S05/S09/S10/S16-S18/S21).
// Inputs are raw comment records + the live HEAD A re-read from GitHub.
// Output is a decision object A must follow; BLOCKED/STALE/NO_TASK never execute.
export function decideResume({ commentRecords, liveHeadSha, trustedAuthors, taskId }) {
  if (!Array.isArray(commentRecords)) {
    return { action: 'BLOCKED', reason: 'comment records unavailable (S06: incomplete read)' };
  }

  // Keep only records from trusted authors; others are untrusted data (§4.1).
  const mine = commentRecords.filter((r) => trustedAuthors.includes(r.author));

  const sel = selectEffectiveOrder(mine);
  if (sel.status === 'NONE') {
    return { action: 'NO_ORDER', reason: 'no valid Supervisor Order found in comments' };
  }
  if (sel.status === 'CONFLICT') {
    return { action: 'BLOCKED', reason: sel.reason, orderId: null };
  }

  const order = sel.record.order;

  // Task binding: never guess the project (S18).
  if (taskId && order.task_id !== taskId) {
    return { action: 'BLOCKED', reason: `order task_id ${order.task_id} does not match expected ${taskId}`, orderId: order.order_id };
  }

  // Structural validation + digest integrity (S11).
  const v = validateOrder(order);
  if (!v.valid || !verifyOrderId(order)) {
    return {
      action: 'BLOCKED',
      reason: `order failed validation: ${v.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      orderId: order.order_id ?? null,
    };
  }

  // S10: forged authority claims inside the payload -> BLOCKED, never executed.
  if (v.warnings.some((w) => w.code === 'POSSIBLE_AUTHORITY_SMUGGLING')) {
    return {
      action: 'BLOCKED',
      reason: 'order payload contains authority-claim text; treated as untrusted data (S10)',
      orderId: order.order_id,
    };
  }

  // Staleness: live HEAD moved after the review (S05/S21).
  const st = checkStaleness(order, liveHeadSha);
  if (st.stale) {
    return { action: 'STALE_ORDER', reason: st.reason, orderId: order.order_id };
  }

  switch (order.decision) {
    case 'ADVANCE':
      return {
        action: 'ADVANCE',
        orderId: order.order_id,
        scope: order.next_action.scope,
        allowedOperations: order.next_action.allowed_operations,
        forbiddenOperations: order.next_action.forbidden_operations,
        requiredResult: order.next_action.required_result,
        note: 'resume from the FIRST unaccepted step; merge/deploy still need separate user approval',
      };
    case 'FIX_REQUIRED':
      return {
        action: 'FIX_REQUIRED',
        orderId: order.order_id,
        findings: order.findings ?? [],
        scope: order.next_action.scope,
        allowedOperations: order.next_action.allowed_operations,
        forbiddenOperations: order.next_action.forbidden_operations,
      };
    case 'BLOCKED':
      return { action: 'BLOCKED', reason: order.next_action.scope, orderId: order.order_id };
    case 'AWAIT_APPROVAL':
      return {
        action: 'AWAIT_APPROVAL',
        reason: order.next_action.scope,
        orderId: order.order_id,
        note: 'stop and request explicit user approval; do not escalate old approvals',
      };
    default:
      return { action: 'BLOCKED', reason: `unknown decision ${order.decision}`, orderId: order.order_id };
  }
}
