import { createHash } from 'node:crypto';
import { canonicalize } from './canonicalize.mjs';

// Deterministic ID material: fields that make an Order unique and replayable.
// Covers repository / task / PR-or-Issue / head / decision / findings / protocol version.
// Deliberately excludes created_at (metadata only, never authority) and notes.
const ORDER_ID_FIELDS = [
  'protocol',
  'task_id',
  'repository',
  'issue_number',
  'pr_number',
  'branch',
  'observed_head_sha',
  'decision',
  'findings',
];

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// orderId material is built from the order's own fields; validation recomputes
// it from the payload EXCLUDING the order_id field itself, and must match.
export function computeOrderId(order) {
  const material = {};
  material.protocol = order.protocol;
  material.task_id = order.task_id;
  const target = order.target ?? {};
  material.repository = target.repository;
  material.issue_number = target.issue_number ?? null;
  material.pr_number = target.pr_number ?? null;
  material.branch = target.branch;
  material.observed_head_sha = target.observed_head_sha;
  material.decision = order.decision;
  material.findings = (order.findings ?? []).map((f) => ({
    finding_id: f.finding_id,
    severity: f.severity,
    file: f.file ?? null,
    line: f.line ?? null,
    observation: f.observation,
    expected: f.expected,
  }));
  void ORDER_ID_FIELDS; // documented key set; material shape is the contract
  return sha256Hex(canonicalize(material));
}

export function verifyOrderId(order) {
  if (typeof order?.order_id !== 'string') return false;
  return computeOrderId(order) === order.order_id;
}

export function computeAckId(ack) {
  const material = {
    protocol: ack.protocol,
    order_id: ack.order_id,
    task_id: ack.task_id,
    repository: ack.repository,
    observed_head_sha: ack.observed_head_sha,
    decision_received: ack.decision_received,
    new_head_sha: ack.new_head_sha ?? null,
  };
  return sha256Hex(canonicalize(material));
}

export function verifyAckId(ack) {
  if (typeof ack?.ack_id !== 'string') return false;
  return computeAckId(ack) === ack.ack_id;
}
