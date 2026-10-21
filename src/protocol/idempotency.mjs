import { verifyOrderId, computeOrderId } from './order-id.mjs';
import { validateOrder } from './validate-order.mjs';

// Idempotency and conflict helpers for the dispatch side (B) and the
// consumption side (A). Pure functions over comment-shaped records:
//   { id, author, created_at, order }   where order is a parsed Order JSON.
//
// Rules (plan §5):
// - Before publishing, B scans existing valid Orders for this task; an
//   identical order_id is REUSED, never reposted (S07/S08).
// - A consumes by GitHub server comment id/created_at + protocol priority,
//   not "the last comment" (S09, §7 step 3).
// - Conflicting verdicts on the same HEAD => BLOCKED, never guess (S09).

export function isValidOrderRecord(rec) {
  return rec && rec.order && validateOrder(rec.order).valid && verifyOrderId(rec.order);
}

// Find an already-published Order identical to `candidate` (S07/S08).
// Returns the existing record to reuse, or null.
export function findDuplicateOrder(existingRecords, candidate) {
  const id = computeOrderId(candidate);
  for (const rec of existingRecords) {
    if (isValidOrderRecord(rec) && rec.order.order_id === id) return rec;
  }
  return null;
}

// A-side consumption: pick the effective Order among comment records.
// Order of precedence:
//   1. valid Order records only (invalid ones are ignored, not executed)
//   2. newest by server created_at, tie-broken by larger server comment id
//   3. if two valid Orders target the SAME observed_head_sha with different
//      decisions (and neither supersedes the other), the result is CONFLICT.
export function selectEffectiveOrder(records) {
  const valid = records.filter(isValidOrderRecord);
  if (valid.length === 0) return { status: 'NONE' };
  const sorted = [...valid].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.id - b.id;
  });
  const latest = sorted[sorted.length - 1];

  // Conflict detection: same HEAD, divergent decisions among ACTIVE orders.
  // An order is retired when another order on the same HEAD names it in
  // supersedes_order_id. Unresolved divergent decisions => BLOCKED (S09).
  const sameHead = sorted.filter(
    (r) => r.order.target.observed_head_sha === latest.order.target.observed_head_sha,
  );
  const supersededIds = new Set(
    sameHead.map((r) => r.order.supersedes_order_id).filter(Boolean),
  );
  const active = sameHead.filter((r) => !supersededIds.has(r.order.order_id));
  const decisions = new Set(active.map((r) => r.order.decision));
  if (decisions.size > 1) {
    return {
      status: 'CONFLICT',
      records: active,
      resolution: 'BLOCKED',
      reason: `conflicting decisions on HEAD ${latest.order.target.observed_head_sha}: ${[...decisions].join(', ')}`,
    };
  }
  const effective = active[active.length - 1];
  return { status: 'OK', record: effective };
}

// Staleness check for A: an Order is STALE when the live HEAD differs from
// the Order's observed_head_sha. A must stop, never port old evidence (S05/S21).
export function checkStaleness(order, liveHeadSha) {
  if (!order || typeof liveHeadSha !== 'string') return { stale: true, reason: 'missing input' };
  const stale = order.target.observed_head_sha !== liveHeadSha;
  return {
    stale,
    reason: stale
      ? `order bound to ${order.target.observed_head_sha}, live HEAD is ${liveHeadSha}`
      : 'order HEAD matches live HEAD',
  };
}
