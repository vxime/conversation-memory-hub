#!/usr/bin/env node
// Prepare (and optionally post) a Supervisor Order dispatch.
// DEFAULT IS DRY-RUN: nothing is posted unless ALL of the following hold:
//   --post  +  --confirm-order-id <exact order_id>  +  env AI_SUPERVISOR_ALLOW_COMMENT_POST=1
//   +  authorization.confirmedByUser === true (passed via --confirm-user)
// Usage:
//   node scripts/dispatch-order.mjs <order.json> --repo <owner/repo> --pr <n> [--issue <n>]
//   node scripts/dispatch-order.mjs <order.json> --repo <owner/repo> --pr <n> --post --confirm-order-id <id> --confirm-user
import { readFileSync, writeFileSync } from 'node:fs';
import { prepareDispatch, collectOrderComments } from '../src/dispatch/dispatch.mjs';
import { postOrderComment } from '../src/dispatch/post.mjs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function has(name) {
  return process.argv.includes(name);
}

const file = process.argv[2];
const repo = arg('--repo');
const pr = Number(arg('--pr') ?? arg('--issue'));
if (!file || !repo || !Number.isInteger(pr) || pr < 1) {
  console.error('usage: node scripts/dispatch-order.mjs <order.json> --repo <owner/repo> --pr <n> [--post --confirm-order-id <id> --confirm-user] [--out <file>]');
  process.exit(2);
}

const order = JSON.parse(readFileSync(file, 'utf8'));
if (order.target?.repository !== repo) {
  console.error(`refusing: order targets ${order.target?.repository}, --repo is ${repo}`);
  process.exit(1);
}

const existing = collectOrderComments({ repo, prNumber: pr });
const prepared = prepareDispatch({ order, existingCommentRecords: existing });

const wantPost = has('--post');
let result = { prepared, existing_order_comments: existing.length };

if (wantPost && prepared.action === 'post') {
  const confirmId = arg('--confirm-order-id');
  const authorization = {
    confirmedByUser: has('--confirm-user'),
    orderId: confirmId,
    scope: `post supervisor order ${prepared.order_id} to ${repo}#${pr}`,
    by: 'cli-operator',
  };
  const posted = postOrderComment({ prepared, authorization });
  result = { ...result, post: posted };
  if (!posted.posted) {
    console.error(`dry-run: ${posted.reason}`);
  }
} else if (wantPost) {
  result.post = { posted: false, dry_run: true, reason: `prepared.action is '${prepared.action}', nothing to post` };
}

const out = arg('--out');
const json = JSON.stringify(result, null, 2) + '\n';
if (out) writeFileSync(out, json);
else process.stdout.write(json);
process.exit(0);
