import { createHash } from 'node:crypto';
import { canonicalize } from '../protocol/canonicalize.mjs';

// Builds a HEAD-bound, read-only review receipt from collected PR evidence.
// The receipt is EVIDENCE, not a verdict: it never emits ADVANCE or
// FIX_REQUIRED. Its conservative recommendation tells the B monitor whether
// the evidence is sufficient to judge at all (fail closed on any gap).

const SHA40 = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function latestRunPerName(checkRuns) {
  const byName = new Map();
  for (const r of checkRuns) {
    const prev = byName.get(r.name);
    const key = (x) => x.completed_at ?? x.started_at ?? '';
    if (!prev || key(r) >= key(prev)) byName.set(r.name, r);
  }
  return byName;
}

export function buildReceipt(evidence, { taskId }) {
  if (!evidence || evidence.protocol !== 'ai-supervisor/pr-evidence/v1') {
    throw new Error('buildReceipt: evidence must be ai-supervisor/pr-evidence/v1');
  }
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new Error('buildReceipt: taskId is required');
  }
  if (!REPO.test(evidence.repo)) throw new Error('buildReceipt: bad repo');
  const headSha = evidence.head_sha_start;
  if (typeof headSha !== 'string' || !SHA40.test(headSha)) {
    throw new Error('buildReceipt: head_sha_start must be a 40-char SHA');
  }

  const latest = latestRunPerName(evidence.check_runs ?? []);
  const required = evidence.required_checks; // null = unknown (fetch failed)

  const checkVerdicts = [];
  if (Array.isArray(required)) {
    for (const name of required) {
      const run = latest.get(name);
      let verdict;
      if (!run) verdict = 'MISSING';
      else if (run.status === 'completed' && run.conclusion === 'success') verdict = 'PASS';
      else if (run.status === 'completed') verdict = 'FAIL';
      else verdict = 'PENDING'; // queued | in_progress
      checkVerdicts.push({
        name, required: true, verdict,
        observed: run ? {
          status: run.status, conclusion: run.conclusion,
          html_url: run.html_url, completed_at: run.completed_at,
        } : null,
      });
    }
  }
  // Non-required runs are reported for completeness (informational only).
  const extraRuns = [];
  const requiredSet = new Set(required ?? []);
  for (const [name, run] of latest) {
    if (!requiredSet.has(name)) {
      extraRuns.push({
        name, required: false,
        verdict: run.status === 'completed' && run.conclusion === 'success' ? 'PASS'
          : run.status === 'completed' ? 'FAIL' : 'PENDING',
        observed: { status: run.status, conclusion: run.conclusion, html_url: run.html_url },
      });
    }
  }

  // Conservative recommendation (fail closed).
  const reasons = [];
  let recommendation;
  if (!evidence.complete) {
    recommendation = 'BLOCKED_MISSING_EVIDENCE';
    reasons.push(`evidence incomplete: ${(evidence.errors ?? []).map((e) => e.where).join(', ')}`);
  } else if (evidence.head_moved_during_collection) {
    recommendation = 'BLOCKED_MISSING_EVIDENCE';
    reasons.push(`HEAD moved during collection (${evidence.head_sha_start} -> ${evidence.head_sha_end}); re-collect`);
  } else if (required === null) {
    recommendation = 'BLOCKED_MISSING_EVIDENCE';
    reasons.push('required check list unknown (branch protection fetch failed)');
  } else if (checkVerdicts.some((c) => c.verdict === 'MISSING' || c.verdict === 'PENDING')) {
    recommendation = 'CI_NOT_COMPLETE';
    reasons.push(`required checks not complete: ${checkVerdicts.filter((c) => c.verdict !== 'PASS').map((c) => `${c.name}=${c.verdict}`).join(', ')}`);
  } else if (checkVerdicts.some((c) => c.verdict === 'FAIL')) {
    recommendation = 'FINDINGS_PRESENT';
    reasons.push(`required checks failed: ${checkVerdicts.filter((c) => c.verdict === 'FAIL').map((c) => c.name).join(', ')} (monitor: FIX_REQUIRED, not ADVANCE)`);
  } else if (checkVerdicts.length === 0) {
    recommendation = 'READY_FOR_REVIEW_DECISION';
    reasons.push('no required checks configured; CI evidence not applicable (recorded, not assumed)');
  } else {
    recommendation = 'READY_FOR_REVIEW_DECISION';
    reasons.push(`all ${checkVerdicts.length} required checks PASS on ${headSha}`);
  }

  const orderComments = (evidence.comments ?? []).filter((c) => c.has_order_header);
  const ackComments = (evidence.comments ?? []).filter((c) => c.has_ack_header);

  const material = {
    protocol: 'ai-supervisor/evidence-receipt/v1',
    task_id: taskId,
    repo: evidence.repo,
    pr_number: evidence.pr_number,
    observed_head_sha: headSha,
    required_checks: (required ?? []).slice().sort(),
    check_verdicts: checkVerdicts.map((c) => ({ name: c.name, verdict: c.verdict })).sort((a, b) => a.name < b.name ? -1 : 1),
    recommendation,
    evidence_complete: evidence.complete,
    head_moved: evidence.head_moved_during_collection,
    order_comment_ids: orderComments.map((c) => c.id).sort((a, b) => a - b),
  };
  const receiptId = createHash('sha256').update(canonicalize(material), 'utf8').digest('hex');

  return {
    protocol: 'ai-supervisor/evidence-receipt/v1',
    receipt_id: receiptId,
    task_id: taskId,
    repo: evidence.repo,
    pr_number: evidence.pr_number,
    observed_head_sha: headSha,
    pr: evidence.pr,
    collected_at: evidence.collected_at,
    evidence_complete: evidence.complete,
    evidence_errors: evidence.errors ?? [],
    head_moved_during_collection: evidence.head_moved_during_collection,
    required_checks: required, // null = unknown
    check_verdicts: checkVerdicts,
    extra_runs: extraRuns,
    comments: {
      count: evidence.comment_count,
      order_comments: orderComments.map((c) => ({ id: c.id, author: c.author, created_at: c.created_at, html_url: c.html_url })),
      ack_comments: ackComments.map((c) => ({ id: c.id, author: c.author, created_at: c.created_at, html_url: c.html_url })),
    },
    sources: evidence.sources ?? [],
    recommendation,
    reasons,
    note: 'Read-only evidence. This receipt never authorizes ADVANCE, merge, deploy, or CI re-runs.',
  };
}
