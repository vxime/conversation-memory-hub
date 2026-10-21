import { computeOrderId } from './order-id.mjs';

// Hand-written authoritative validator for Supervisor Order v1.
// Mirrors schemas/supervisor-order.v1.schema.json plus §4.2 semantic rules:
// - deterministic order_id must match the canonical material
// - SHA must be 40-char hex (placeholder text is never valid)
// - paths normalized and repo-relative; no absolute local paths
// - no token-bearing URLs, no newline injection in string fields
// - target must name an Issue or PR channel (at least one present)
// - decision/allowed/forbidden operation enums from the plan

const SHA40 = /^[0-9a-f]{40}$/;
const ORDERID = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TASKID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FINDINGID = /^F-[0-9]{3}$/;

const DECISIONS = ['ADVANCE', 'FIX_REQUIRED', 'BLOCKED', 'AWAIT_APPROVAL'];
const CI_STATUS = ['SUCCESS', 'FAILED', 'QUEUED', 'IN_PROGRESS', 'SKIPPED', 'CANCELLED', 'UNKNOWN'];
const SEVERITY = ['BLOCKER', 'MAJOR', 'MINOR'];
// Single operation vocabulary. The privileged four can appear in
// forbidden_operations (to say "explicitly off-limits") but never in
// allowed_operations (an Order cannot authorize them, S20).
const OPS = [
  'edit_feature_branch',
  'run_scoped_tests',
  'update_checkpoint',
  'read_only_review',
  'post_comment',
  'request_user_approval',
  'merge',
  'production_deploy',
  'publish',
  'modify_approval',
  'install_runner',
  'modify_production_config',
  'rerun_ci',
];
const PRIVILEGED_NEVER_ALLOWED = ['merge', 'production_deploy', 'publish', 'install_runner'];

// Patterns that must never appear in wire strings (token leak / injection).
const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9_]+/, // GitHub token prefixes
  /x-access-token/i,
  /[?&]token=/i,
  /[?&]access_token=/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /[\r\n]/, // newline injection
];

// Phrases that look like an attempt to smuggle authority into the payload.
// Validator reports them as warnings; the resume consumer MUST treat any
// such warning as BLOCKED (acceptance case S10).
const AUTHORITY_PHRASES = [
  /ignore (all |previous |prior |earlier )?instructions?/i,
  /\bsystem\s*:/i,
  /you are (now |meta |an? )/i,
  /owner (has |had )?(approved|confirmed|authorized)/i,
  /user (has |had )?(approved|confirmed|authorized)/i,
  /approved[- ]by[- ]owner/i,
  /merge (is |has been )?approved/i,
  /deploy (is |has been )?approved/i,
  /override (the )?approval/i,
];

function isStr(v, min = 1, max = 4000) {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}

function cleanPath(p) {
  // Repo-relative, forward slashes, no traversal, no absolute, no drive letters.
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    p.length <= 512 &&
    !p.startsWith('/') &&
    !/^[A-Za-z]:[\\/]/.test(p) &&
    !p.includes('\\') &&
    !/(^|\/)\.\.(\/|$)/.test(p) &&
    !/[\r\n]/.test(p)
  );
}

export function scanSecrets(value, path, out) {
  if (typeof value !== 'string') return;
  for (const re of SECRET_PATTERNS) {
    if (re.test(value)) {
      out.push({
        code: 'SECRET_OR_INJECTION',
        path,
        message: `string contains a forbidden token/secret pattern or newline injection (${re})`,
      });
      return; // one report per field is enough
    }
  }
}

export function scanAuthority(value, path, warnings) {
  if (typeof value !== 'string') return;
  for (const re of AUTHORITY_PHRASES) {
    if (re.test(value)) {
      warnings.push({
        code: 'POSSIBLE_AUTHORITY_SMUGGLING',
        path,
        message: `payload text matches an authority-claim pattern (${re}); consumer must BLOCK (S10)`,
      });
      return;
    }
  }
}

function err(path, message, code = 'INVALID') {
  return { code, path, message };
}

// Collect every string leaf for secret scanning, except order_id/ack_id digests.
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

export function validateOrder(order) {
  const errors = [];
  const warnings = [];

  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    return { valid: false, errors: [err('', 'order must be an object')], warnings };
  }

  // 1. Structural allow-list (additionalProperties: false at every level).
  const TOP = [
    'protocol', 'order_id', 'task_id', 'target', 'decision', 'evidence',
    'findings', 'next_action', 'supersedes_order_id', 'created_at', 'notes',
  ];
  for (const k of Object.keys(order)) {
    if (!TOP.includes(k)) errors.push(err(k, `unknown top-level field '${k}'`, 'UNKNOWN_FIELD'));
  }

  // 2. protocol / order_id
  if (order.protocol !== 'ai-supervisor/order/v1') {
    errors.push(err('protocol', 'protocol must be ai-supervisor/order/v1'));
  }
  if (typeof order.order_id !== 'string' || !ORDERID.test(order.order_id)) {
    errors.push(err('order_id', 'order_id must be a 64-char lowercase hex digest'));
  } else if (computeOrderId(order) !== order.order_id) {
    errors.push(err('order_id', 'order_id does not match deterministic digest of order material', 'ORDER_ID_MISMATCH'));
  }
  if (order.supersedes_order_id != null &&
      (typeof order.supersedes_order_id !== 'string' || !ORDERID.test(order.supersedes_order_id))) {
    errors.push(err('supersedes_order_id', 'supersedes_order_id must be a 64-char hex digest or null'));
  }

  // 3. task_id
  if (!isStr(order.task_id, 1, 128) || !TASKID.test(order.task_id)) {
    errors.push(err('task_id', 'task_id must match ^[A-Za-z0-9][A-Za-z0-9._-]*$ (max 128)'));
  }

  // 4. target
  const t = order.target;
  if (!t || typeof t !== 'object' || Array.isArray(t)) {
    errors.push(err('target', 'target must be an object'));
  } else {
    const TK = ['repository', 'issue_number', 'pr_number', 'branch', 'observed_head_sha'];
    for (const k of Object.keys(t)) {
      if (!TK.includes(k)) errors.push(err(`target.${k}`, `unknown target field '${k}'`, 'UNKNOWN_FIELD'));
    }
    if (!isStr(t.repository, 1, 160) || !REPO.test(t.repository)) {
      errors.push(err('target.repository', 'repository must be owner/repo'));
    }
    if (!isStr(t.branch, 1, 255) || /(^|\/)(\.|\.\.)(\/|$)/.test(t.branch)) {
      errors.push(err('target.branch', 'branch must be a normalized ref name (no . or ..)'));
    }
    if (typeof t.observed_head_sha !== 'string' || !SHA40.test(t.observed_head_sha)) {
      errors.push(err('target.observed_head_sha', 'observed_head_sha must be a 40-char full Git SHA read from GitHub', 'BAD_SHA'));
    }
    const hasIssue = Number.isInteger(t.issue_number) && t.issue_number >= 1;
    const hasPr = Number.isInteger(t.pr_number) && t.pr_number >= 1;
    if (!hasIssue && !hasPr) {
      errors.push(err('target', 'at least one of issue_number or pr_number is required (dispatch channel)', 'NO_CHANNEL'));
    }
    if (t.issue_number != null && !hasIssue) errors.push(err('target.issue_number', 'issue_number must be a positive integer or null'));
    if (t.pr_number != null && !hasPr) errors.push(err('target.pr_number', 'pr_number must be a positive integer or null'));
  }

  // 5. decision
  if (!DECISIONS.includes(order.decision)) {
    errors.push(err('decision', `decision must be one of ${DECISIONS.join('|')}`));
  }

  // 6. evidence
  const e = order.evidence;
  if (!e || typeof e !== 'object' || Array.isArray(e)) {
    errors.push(err('evidence', 'evidence must be an object'));
  } else {
    const EK = ['plan_path', 'checkpoint_path', 'diff_ref', 'ci'];
    for (const k of Object.keys(e)) {
      if (!EK.includes(k)) errors.push(err(`evidence.${k}`, `unknown evidence field '${k}'`, 'UNKNOWN_FIELD'));
    }
    if (!cleanPath(e.plan_path)) errors.push(err('evidence.plan_path', 'plan_path must be a normalized repo-relative path'));
    if (!cleanPath(e.checkpoint_path)) errors.push(err('evidence.checkpoint_path', 'checkpoint_path must be a normalized repo-relative path'));
    if (!isStr(e.diff_ref, 1, 512)) errors.push(err('evidence.diff_ref', 'diff_ref must be a non-empty exact review source'));
    const ci = e.ci;
    if (!ci || typeof ci !== 'object' || Array.isArray(ci)) {
      errors.push(err('evidence.ci', 'evidence.ci must be an object'));
    } else {
      const CK = ['head_sha', 'required_checks'];
      for (const k of Object.keys(ci)) {
        if (!CK.includes(k)) errors.push(err(`evidence.ci.${k}`, `unknown ci field '${k}'`, 'UNKNOWN_FIELD'));
      }
      if (typeof ci.head_sha !== 'string' || !SHA40.test(ci.head_sha)) {
        errors.push(err('evidence.ci.head_sha', 'ci.head_sha must be a 40-char full Git SHA', 'BAD_SHA'));
      }
      if (!Array.isArray(ci.required_checks) || ci.required_checks.length < 1 || ci.required_checks.length > 64) {
        errors.push(err('evidence.ci.required_checks', 'required_checks must be a non-empty array (1..64)'));
      } else {
        ci.required_checks.forEach((c, i) => {
          const p = `evidence.ci.required_checks[${i}]`;
          if (!c || typeof c !== 'object' || Array.isArray(c)) {
            errors.push(err(p, 'check must be an object'));
            return;
          }
          const CQK = ['name', 'status', 'run_id', 'run_attempt', 'url'];
          for (const k of Object.keys(c)) {
            if (!CQK.includes(k)) errors.push(err(`${p}.${k}`, `unknown check field '${k}'`, 'UNKNOWN_FIELD'));
          }
          if (!isStr(c.name, 1, 256)) errors.push(err(`${p}.name`, 'check name must be a non-empty string'));
          if (!CI_STATUS.includes(c.status)) {
            errors.push(err(`${p}.status`, `check status must be one of ${CI_STATUS.join('|')}`));
          }
          if (c.run_id != null && (!Number.isInteger(c.run_id) || c.run_id < 1)) {
            errors.push(err(`${p}.run_id`, 'run_id must be a positive integer or null'));
          }
          if (c.run_attempt != null && (!Number.isInteger(c.run_attempt) || c.run_attempt < 1)) {
            errors.push(err(`${p}.run_attempt`, 'run_attempt must be a positive integer or null'));
          }
          if (c.url != null && (typeof c.url !== 'string' || c.url.length > 2048 || c.url.length < 1)) {
            errors.push(err(`${p}.url`, 'url must be a short string or null'));
          }
        });
      }
    }
  }

  // 7. findings
  if (order.findings != null) {
    if (!Array.isArray(order.findings) || order.findings.length > 128) {
      errors.push(err('findings', 'findings must be an array (max 128) or omitted'));
    } else {
      order.findings.forEach((f, i) => {
        const p = `findings[${i}]`;
        if (!f || typeof f !== 'object' || Array.isArray(f)) {
          errors.push(err(p, 'finding must be an object'));
          return;
        }
        const FK = ['finding_id', 'severity', 'file', 'line', 'observation', 'expected'];
        for (const k of Object.keys(f)) {
          if (!FK.includes(k)) errors.push(err(`${p}.${k}`, `unknown finding field '${k}'`, 'UNKNOWN_FIELD'));
        }
        if (typeof f.finding_id !== 'string' || !FINDINGID.test(f.finding_id)) {
          errors.push(err(`${p}.finding_id`, 'finding_id must match ^F-[0-9]{3}$'));
        }
        if (!SEVERITY.includes(f.severity)) {
          errors.push(err(`${p}.severity`, `severity must be one of ${SEVERITY.join('|')}`));
        }
        if (f.file != null && !cleanPath(f.file)) {
          errors.push(err(`${p}.file`, 'file must be a normalized repo-relative path or null'));
        }
        if (f.line != null && (!Number.isInteger(f.line) || f.line < 1 || f.line > 10000000)) {
          errors.push(err(`${p}.line`, 'line must be a positive integer or null'));
        }
        if (!isStr(f.observation, 1, 4000)) errors.push(err(`${p}.observation`, 'observation must be a non-empty string'));
        if (!isStr(f.expected, 1, 4000)) errors.push(err(`${p}.expected`, 'expected must be a non-empty string'));
      });
    }
  }

  // 8. next_action
  const n = order.next_action;
  if (!n || typeof n !== 'object' || Array.isArray(n)) {
    errors.push(err('next_action', 'next_action must be an object'));
  } else {
    const NK = ['scope', 'allowed_operations', 'forbidden_operations', 'required_result'];
    for (const k of Object.keys(n)) {
      if (!NK.includes(k)) errors.push(err(`next_action.${k}`, `unknown next_action field '${k}'`, 'UNKNOWN_FIELD'));
    }
    if (!isStr(n.scope, 1, 2000)) errors.push(err('next_action.scope', 'scope must be a non-empty string'));
    if (!Array.isArray(n.allowed_operations) || n.allowed_operations.length < 1 || n.allowed_operations.length > 16) {
      errors.push(err('next_action.allowed_operations', 'allowed_operations must be a non-empty array (1..16)'));
    } else {
      for (const op of n.allowed_operations) {
        if (!OPS.includes(op)) errors.push(err('next_action.allowed_operations', `unknown operation '${op}'`));
        if (PRIVILEGED_NEVER_ALLOWED.includes(op)) {
          errors.push(err('next_action.allowed_operations', `'${op}' can never be an allowed operation (S20)`, 'PRIVILEGE_ESCALATION'));
        }
      }
      if (new Set(n.allowed_operations).size !== n.allowed_operations.length) {
        errors.push(err('next_action.allowed_operations', 'allowed_operations must be unique'));
      }
    }
    if (!Array.isArray(n.forbidden_operations) || n.forbidden_operations.length < 1 || n.forbidden_operations.length > 16) {
      errors.push(err('next_action.forbidden_operations', 'forbidden_operations must be a non-empty array (1..16)'));
    } else {
      for (const op of n.forbidden_operations) {
        if (!OPS.includes(op)) errors.push(err('next_action.forbidden_operations', `unknown operation '${op}'`));
      }
      if (new Set(n.forbidden_operations).size !== n.forbidden_operations.length) {
        errors.push(err('next_action.forbidden_operations', 'forbidden_operations must be unique'));
      }
    }
    const overlap = (n.allowed_operations ?? []).filter((op) => (n.forbidden_operations ?? []).includes(op));
    if (overlap.length > 0) {
      errors.push(err('next_action', `operation listed in both allowed and forbidden: ${overlap.join(',')}`, 'OP_CONFLICT'));
    }
    if (!isStr(n.required_result, 1, 2000)) errors.push(err('next_action.required_result', 'required_result must be a non-empty string'));
  }

  // 9. Decision / findings coherence.
  const findings = order.findings ?? [];
  const hasHard = findings.some((f) => f && (f.severity === 'BLOCKER' || f.severity === 'MAJOR'));
  if (order.decision === 'ADVANCE' && hasHard) {
    errors.push(err('decision', 'ADVANCE must not carry BLOCKER/MAJOR findings; use FIX_REQUIRED', 'DECISION_FINDING_MISMATCH'));
  }
  if (order.decision === 'FIX_REQUIRED' && findings.length === 0) {
    errors.push(err('decision', 'FIX_REQUIRED requires at least one finding', 'DECISION_FINDING_MISMATCH'));
  }

  // 10. Secret / injection scan across all string leaves (skip the digests themselves).
  walkStrings(order, '', (value, path) => {
    if (/(^|\.)(order_id|supersedes_order_id|ack_id)$/.test(path)) return;
    scanSecrets(value, path, errors);
  });

  // 11. Authority-smuggling heuristic -> warnings (consumer must BLOCK, S10).
  walkStrings(order, '', (value, path) => {
    scanAuthority(value, path, warnings);
  });

  return { valid: errors.length === 0, errors, warnings };
}
