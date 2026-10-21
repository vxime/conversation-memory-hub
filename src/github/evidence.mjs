import { createHash } from 'node:crypto';
import { ghJson } from './gh.mjs';

// Read-only evidence collection for one PR. Every fetch is recorded in
// `sources[]`; any failure marks the evidence incomplete (fail closed).
// Nothing here writes to GitHub.

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function source(kind, ref, detail = {}) {
  return { kind, ref, fetched_at: new Date().toISOString(), ...detail };
}

export function collectPrEvidence({ repo, prNumber, gh = { json: ghJson } }) {
  const sources = [];
  const errors = [];
  const evidence = {
    protocol: 'ai-supervisor/pr-evidence/v1',
    repo,
    pr_number: prNumber,
    collected_at: new Date().toISOString(),
    pr: null,
    head_sha_start: null,
    head_sha_end: null,
    head_moved_during_collection: null,
    base_ref: null,
    required_checks: null, // null = unknown (fetch failed); [] = none configured
    check_runs: [],
    workflow_runs: [],
    comments: [],
    comment_count: null,
    sources,
    errors,
    complete: true,
  };

  const note = (kind, ref, detail) => sources.push(source(kind, ref, detail));
  const fail = (where, err) => {
    evidence.complete = false;
    errors.push({ where, message: String(err?.message ?? err).slice(0, 500) });
  };

  // 1. PR metadata (authoritative HEAD at start).
  try {
    const pr = gh.json([
      'pr', 'view', String(prNumber), '--repo', repo,
      '--json', 'number,title,state,baseRefName,headRefName,headRefOid,url,mergedAt,createdAt',
    ]);
    evidence.pr = {
      number: pr.number, title: pr.title, state: pr.state,
      base_ref: pr.baseRefName, head_ref: pr.headRefName,
      head_sha: pr.headRefOid, url: pr.url,
      merged_at: pr.mergedAt ?? null, created_at: pr.createdAt,
    };
    evidence.head_sha_start = pr.headRefOid;
    evidence.base_ref = pr.baseRefName;
    note('pr', pr.url, { head_sha: pr.headRefOid });
  } catch (e) { fail('pr_view', e); }

  const headSha = evidence.head_sha_start;

  // 2. Branch protection: required status checks (live, not cached).
  if (evidence.base_ref) {
    try {
      const prot = gh.json([
        'api', `repos/${repo}/branches/${encodeURIComponent(evidence.base_ref)}/protection/required_status_checks`,
      ]);
      const names = [
        ...(prot?.checks ?? []).map((c) => c.context),
        ...(prot?.contexts ?? []),
      ];
      evidence.required_checks = [...new Set(names)];
      note('branch_protection', `repos/${repo}/branches/${evidence.base_ref}/protection/required_status_checks`, {
        required: evidence.required_checks,
      });
    } catch (e) {
      // 404 = no protection configured: a fact, not missing data.
      if (/404|Not Found/i.test(String(e?.message ?? e))) {
        evidence.required_checks = [];
        note('branch_protection', `repos/${repo}/branches/${evidence.base_ref}/protection`, {
          required: [], note: 'no branch protection (404)',
        });
      } else {
        fail('branch_protection', e);
      }
    }
  }

  // 3. Check runs for the PR HEAD (current SHA only).
  if (headSha) {
    try {
      const res = gh.json(['api', `repos/${repo}/commits/${headSha}/check-runs`, '--paginate']);
      const runs = res?.check_runs ?? (Array.isArray(res) ? res : []);
      evidence.check_runs = runs.map((r) => ({
        name: r.name,
        status: r.status, // queued | in_progress | completed
        conclusion: r.conclusion ?? null,
        html_url: r.html_url,
        started_at: r.started_at ?? null,
        completed_at: r.completed_at ?? null,
      }));
      note('check_runs', `repos/${repo}/commits/${headSha}/check-runs`, { count: evidence.check_runs.length });
    } catch (e) { fail('check_runs', e); }

    // 4. Workflow runs for the HEAD (supplementary run_id/attempt mapping).
    try {
      const res = gh.json(['api', `repos/${repo}/actions/runs?head_sha=${headSha}`, '--paginate']);
      const runs = res?.workflow_runs ?? [];
      evidence.workflow_runs = runs.map((r) => ({
        id: r.id, name: r.name, status: r.status,
        conclusion: r.conclusion ?? null, html_url: r.html_url,
        run_attempt: r.run_attempt ?? null, created_at: r.created_at,
      }));
      note('workflow_runs', `repos/${repo}/actions/runs?head_sha=${headSha}`, { count: evidence.workflow_runs.length });
    } catch (e) { fail('workflow_runs', e); }
  }

  // 5. Comments (paginated; bodies hashed, not stored, to keep receipts compact).
  try {
    const comments = gh.json(['api', `repos/${repo}/issues/${prNumber}/comments`, '--paginate']);
    const list = Array.isArray(comments) ? comments : [];
    evidence.comment_count = list.length;
    evidence.comments = list.map((c) => ({
      id: c.id,
      author: c.user?.login ?? null,
      created_at: c.created_at,
      html_url: c.html_url,
      body_sha256: sha256Hex(c.body ?? ''),
      body_length: (c.body ?? '').length,
      has_order_header: (c.body ?? '').includes('AI-SUPERVISOR-ORDER/v1'),
      has_ack_header: (c.body ?? '').includes('AI-SUPERVISOR-ACK/v1'),
    }));
    note('comments', `repos/${repo}/issues/${prNumber}/comments`, { count: list.length, paginated: true });
  } catch (e) { fail('comments', e); }

  // 6. Re-read PR HEAD at the end: detect movement during collection.
  try {
    const pr2 = gh.json([
      'pr', 'view', String(prNumber), '--repo', repo, '--json', 'headRefOid',
    ]);
    evidence.head_sha_end = pr2.headRefOid;
    evidence.head_moved_during_collection = pr2.headRefOid !== evidence.head_sha_start;
    note('pr_head_reread', `pr/${prNumber}`, { head_sha: pr2.headRefOid });
    if (evidence.head_moved_during_collection) {
      evidence.complete = false;
      errors.push({
        where: 'head_reread',
        message: `HEAD moved during collection: ${evidence.head_sha_start} -> ${evidence.head_sha_end}`,
      });
    }
  } catch (e) { fail('pr_head_reread', e); }

  return evidence;
}
