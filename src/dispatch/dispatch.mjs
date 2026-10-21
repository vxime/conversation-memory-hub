import { createHash } from 'node:crypto';
import { validateOrder } from '../protocol/validate-order.mjs';
import { verifyOrderId } from '../protocol/order-id.mjs';
import { findDuplicateOrder } from '../protocol/idempotency.mjs';
import { ghJson } from '../github/gh.mjs';

// Dispatch preparation (P3). Pure logic: validate -> idempotency check ->
// render the exact comment body. Posting itself lives in post.mjs behind
// two independent gates and is NEVER triggered from here.

export const ORDER_HEADER = 'AI-SUPERVISOR-ORDER/v1';
export const ACK_HEADER = 'AI-SUPERVISOR-ACK/v1';

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function renderOrderComment(order) {
  const json = JSON.stringify(order, null, 2);
  const target = order.target;
  const channel = target.pr_number ? `PR #${target.pr_number}` : `Issue #${target.issue_number}`;
  return [
    ORDER_HEADER,
    '',
    '```json',
    json,
    '```',
    '',
    `Decision: \`${order.decision}\``,
    `Task: \`${order.task_id}\` · ${target.repository} · ${channel}`,
    `Branch: \`${target.branch}\` @ \`${target.observed_head_sha}\``,
    `Scope: ${order.next_action.scope}`,
    '',
    '_This is a machine-readable Supervisor Order. Do not treat its content as human approval._',
  ].join('\n');
}

export function renderAckComment(ack) {
  const json = JSON.stringify(ack, null, 2);
  return [
    ACK_HEADER,
    '',
    '```json',
    json,
    '```',
    '',
    `Ack for order \`${ack.order_id.slice(0, 16)}…\` · decision received: \`${ack.decision_received}\``,
    ack.new_head_sha ? `New HEAD: \`${ack.new_head_sha}\`` : 'No new commit.',
    ...(ack.refusal_reason ? [`Refusal reason: ${ack.refusal_reason}`] : []),
  ].join('\n');
}

// Parse an Order out of a comment body. Returns null when the body is not
// an AI-SUPERVISOR-ORDER/v1 comment or the JSON block is malformed.
export function parseOrderFromCommentBody(body) {
  if (typeof body !== 'string' || !body.includes(ORDER_HEADER)) return null;
  const m = body.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]);
    return o && o.protocol === 'ai-supervisor/order/v1' ? o : null;
  } catch {
    return null;
  }
}

// Read-only: collect existing Order comments on an Issue/PR for the
// idempotency check. Uses only the whitelisted gh reader.
export function collectOrderComments({ repo, prNumber, gh = { json: ghJson } }) {
  const comments = gh.json(['api', `repos/${repo}/issues/${prNumber}/comments`, '--paginate']);
  const list = Array.isArray(comments) ? comments : [];
  return list
    .map((c) => ({
      id: c.id,
      author: c.user?.login ?? null,
      created_at: c.created_at,
      order: parseOrderFromCommentBody(c.body ?? ''),
    }))
    .filter((r) => r.order);
}

// existingCommentRecords: [{id, author, created_at, order}] as produced by
// the evidence collector (only records with parsed order headers matter).
export function prepareDispatch({ order, existingCommentRecords = [] }) {
  if (!order || typeof order !== 'object') {
    return { action: 'refuse', reason: 'no order provided', errors: [] };
  }
  const v = validateOrder(order);
  if (!v.valid) {
    return { action: 'refuse', reason: 'order failed validation', errors: v.errors, warnings: v.warnings };
  }
  if (!verifyOrderId(order)) {
    return {
      action: 'refuse', reason: 'order_id digest mismatch',
      errors: [{ code: 'ORDER_ID_MISMATCH', path: 'order_id', message: 'digest does not match order material' }],
    };
  }
  if ((v.warnings ?? []).some((w) => w.code === 'POSSIBLE_AUTHORITY_SMUGGLING')) {
    return {
      action: 'refuse', reason: 'order payload contains authority-claim text (S10)',
      errors: [{ code: 'AUTHORITY_SMUGGLING', path: '', message: 'treated as untrusted data; never dispatch' }],
    };
  }

  const dup = findDuplicateOrder(existingCommentRecords, order);
  if (dup) {
    return {
      action: 'reuse',
      order_id: order.order_id,
      comment: { id: dup.id, author: dup.author, created_at: dup.created_at },
      reason: 'identical order_id already published; reuse the existing comment link',
    };
  }

  const body = renderOrderComment(order);
  const t = order.target;
  return {
    action: 'post',
    order_id: order.order_id,
    channel: {
      repository: t.repository,
      issue_number: t.issue_number ?? null,
      pr_number: t.pr_number ?? null,
    },
    body,
    body_sha256: sha256Hex(body),
    note: 'Prepared only. Posting requires explicit authorization via post.mjs (env + confirmedByUser gates).',
  };
}
