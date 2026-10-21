import { execFileSync } from 'node:child_process';
import { sha256Hex } from './dispatch.mjs';

// The SINGLE write path for Supervisor comments. Two independent gates,
// both required; default is a dry-run refusal and NOTHING is spawned.
//
// Gate 1 (environment): AI_SUPERVISOR_ALLOW_COMMENT_POST === '1'.
// Gate 2 (explicit authorization object): { confirmedByUser: true,
//          orderId, scope, by } — confirmedByUser must be literally true.
//
// This module deliberately does NOT use src/github/gh.mjs (which is
// read-only by construction).

const ENV_FLAG = 'AI_SUPERVISOR_ALLOW_COMMENT_POST';

export function checkPostAuthorization({ authorization, prepared }) {
  const problems = [];
  if (process.env[ENV_FLAG] !== '1') {
    problems.push(`env ${ENV_FLAG} is not '1'`);
  }
  if (!authorization || typeof authorization !== 'object') {
    problems.push('missing authorization object');
  } else {
    if (authorization.confirmedByUser !== true) problems.push('authorization.confirmedByUser is not true');
    if (!authorization.orderId) problems.push('authorization.orderId missing');
    else if (prepared && authorization.orderId !== prepared.order_id) {
      problems.push('authorization.orderId does not match the prepared order');
    }
    if (!authorization.scope) problems.push('authorization.scope missing');
  }
  return { ok: problems.length === 0, problems };
}

// transport: injectable for tests. Default transport posts via gh and reads
// the comment back. Signature: ({repo, issueNumber, body}) -> {id, html_url, body}
// and ({repo, commentId}) -> {id, html_url, body} for readback.
function defaultTransport() {
  const post = ({ repo, issueNumber, body }) => {
    const out = execFileSync(
      'gh', ['api', '-X', 'POST', `repos/${repo}/issues/${issueNumber}/comments`, '-f', `body=${body}`],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
    );
    const c = JSON.parse(out);
    return { id: c.id, html_url: c.html_url, body: c.body };
  };
  const read = ({ repo, commentId }) => {
    const out = execFileSync(
      'gh', ['api', `repos/${repo}/issues/comments/${commentId}`],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
    );
    const c = JSON.parse(out);
    return { id: c.id, html_url: c.html_url, body: c.body };
  };
  return { post, read };
}

export function postOrderComment({ prepared, authorization, transport = defaultTransport() }) {
  if (!prepared || prepared.action !== 'post') {
    return { posted: false, dry_run: true, reason: 'nothing to post: prepared.action is not "post"', prepared };
  }
  const gate = checkPostAuthorization({ authorization, prepared });
  if (!gate.ok) {
    return {
      posted: false, dry_run: true,
      reason: `post authorization gates not satisfied: ${gate.problems.join('; ')}`,
      prepared,
      would_post: {
        repository: prepared.channel.repository,
        issue_number: prepared.channel.issue_number ?? prepared.channel.pr_number,
        body_sha256: prepared.body_sha256,
      },
    };
  }

  const repo = prepared.channel.repository;
  const issueNumber = prepared.channel.issue_number ?? prepared.channel.pr_number;
  const posted = transport.post({ repo, issueNumber, body: prepared.body });

  // Read back and verify: the comment we read must be byte-identical.
  const readBack = transport.read({ repo, commentId: posted.id });
  const readSha = sha256Hex(readBack.body ?? '');
  if (readSha !== prepared.body_sha256) {
    return {
      posted: true, verified: false,
      comment: { id: posted.id, html_url: posted.html_url ?? readBack.html_url },
      reason: `readback body hash mismatch: expected ${prepared.body_sha256}, got ${readSha}`,
      prepared,
    };
  }
  return {
    posted: true, verified: true,
    comment: { id: posted.id, html_url: posted.html_url ?? readBack.html_url, body_sha256: readSha },
    order_id: prepared.order_id,
  };
}
