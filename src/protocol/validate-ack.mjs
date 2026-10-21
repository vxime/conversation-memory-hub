import { computeAckId } from './order-id.mjs';
import { scanSecrets, scanAuthority } from './validate-order.mjs';

// Validator for Supervisor ACK v1 (developer evidence of consuming an Order).
// An ACK is only meaningful when it references a real Order; wire validation
// here covers shape, digest integrity and staleness fields. The resume-side
// consumer additionally checks order existence, decision match and HEAD.

const SHA40 = /^[0-9a-f]{40}$/;
const ACKID = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TASKID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DECISIONS = ['ADVANCE', 'FIX_REQUIRED', 'BLOCKED', 'AWAIT_APPROVAL', 'STALE_ORDER'];

function isStr(v, min = 1, max = 4000) {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}

function walkStrings(node, path, cb) {
  if (typeof node === 'string') {
    cb(node, path);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkStrings(v, `${path}[${i}]`, cb));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      walkStrings(v, path ? `${path}.${k}` : k, cb);
    }
  }
}

export function validateAck(ack) {
  const errors = [];
  const warnings = [];
  const err = (path, message, code = 'INVALID') => ({ code, path, message });

  if (!ack || typeof ack !== 'object' || Array.isArray(ack)) {
    return { valid: false, errors: [err('', 'ack must be an object')], warnings };
  }

  const TOP = [
    'protocol', 'ack_id', 'order_id', 'task_id', 'repository',
    'observed_head_sha', 'decision_received', 'new_head_sha',
    'executed', 'refusal_reason', 'comment_url', 'created_at',
  ];
  for (const k of Object.keys(ack)) {
    if (!TOP.includes(k)) errors.push(err(k, `unknown top-level field '${k}'`, 'UNKNOWN_FIELD'));
  }

  if (ack.protocol !== 'ai-supervisor/ack/v1') {
    errors.push(err('protocol', 'protocol must be ai-supervisor/ack/v1'));
  }
  if (typeof ack.ack_id !== 'string' || !ACKID.test(ack.ack_id)) {
    errors.push(err('ack_id', 'ack_id must be a 64-char lowercase hex digest'));
  } else if (computeAckId(ack) !== ack.ack_id) {
    errors.push(err('ack_id', 'ack_id does not match deterministic digest of ack material', 'ACK_ID_MISMATCH'));
  }
  if (typeof ack.order_id !== 'string' || !ACKID.test(ack.order_id)) {
    errors.push(err('order_id', 'order_id must be a 64-char hex digest of the consumed Order'));
  }
  if (!isStr(ack.task_id, 1, 128) || !TASKID.test(ack.task_id)) {
    errors.push(err('task_id', 'task_id must match ^[A-Za-z0-9][A-Za-z0-9._-]*$ (max 128)'));
  }
  if (!isStr(ack.repository, 1, 160) || !REPO.test(ack.repository)) {
    errors.push(err('repository', 'repository must be owner/repo'));
  }
  if (typeof ack.observed_head_sha !== 'string' || !SHA40.test(ack.observed_head_sha)) {
    errors.push(err('observed_head_sha', 'observed_head_sha must be a 40-char full Git SHA', 'BAD_SHA'));
  }
  if (!DECISIONS.includes(ack.decision_received)) {
    errors.push(err('decision_received', `decision_received must be one of ${DECISIONS.join('|')}`));
  }
  if (ack.new_head_sha != null && (typeof ack.new_head_sha !== 'string' || !SHA40.test(ack.new_head_sha))) {
    errors.push(err('new_head_sha', 'new_head_sha must be a 40-char full Git SHA or null', 'BAD_SHA'));
  }
  if (ack.executed != null) {
    if (!Array.isArray(ack.executed) || ack.executed.length > 64 ||
        ack.executed.some((s) => typeof s !== 'string' || s.length < 1 || s.length > 2000)) {
      errors.push(err('executed', 'executed must be an array of non-empty strings (max 64, each max 2000)'));
    }
  }
  if (ack.refusal_reason != null && !isStr(ack.refusal_reason, 1, 4000)) {
    errors.push(err('refusal_reason', 'refusal_reason must be a non-empty string or null'));
  }
  if (ack.comment_url != null && !isStr(ack.comment_url, 1, 2048)) {
    errors.push(err('comment_url', 'comment_url must be a non-empty string or null'));
  }
  // Refusal must be explained: STALE_ORDER/BLOCKED with no execution needs a reason.
  const didNothing = !Array.isArray(ack.executed) || ack.executed.length === 0;
  if ((ack.decision_received === 'STALE_ORDER' || ack.decision_received === 'BLOCKED') &&
      didNothing && ack.refusal_reason == null) {
    errors.push(err('refusal_reason', 'refusal_reason is required when nothing was executed for STALE_ORDER/BLOCKED', 'MISSING_REFUSAL_REASON'));
  }

  walkStrings(ack, '', (value, path) => {
    if (/(^|\.)(ack_id|order_id)$/.test(path)) return;
    scanSecrets(value, path, errors);
  });
  walkStrings(ack, '', (value, path) => {
    scanAuthority(value, path, warnings);
  });

  return { valid: errors.length === 0, errors, warnings };
}
