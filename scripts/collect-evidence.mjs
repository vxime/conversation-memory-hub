#!/usr/bin/env node
// Collect read-only GitHub evidence for a PR and emit a HEAD-bound review receipt.
// Usage: node scripts/collect-evidence.mjs <owner/repo> <pr-number> [--task <task-id>] [--out <file>]
// Read-only: uses only whitelisted gh commands (see src/github/gh.mjs).
// Exit 0 = receipt built (check .recommendation); exit 1 = collection/validation failure.
import { writeFileSync } from 'node:fs';
import { collectPrEvidence } from '../src/github/evidence.mjs';
import { buildReceipt } from '../src/review/evidence-receipt.mjs';

const args = process.argv.slice(2);
const repo = args[0];
const prNumber = Number(args[1]);
const taskIdx = args.indexOf('--task');
const outIdx = args.indexOf('--out');
const taskId = taskIdx >= 0 ? args[taskIdx + 1] : `evidence-${repo?.replace('/', '-')}-pr${prNumber}`;
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;

if (!repo || !Number.isInteger(prNumber) || prNumber < 1) {
  console.error('usage: node scripts/collect-evidence.mjs <owner/repo> <pr-number> [--task <task-id>] [--out <file>]');
  process.exit(2);
}

try {
  const evidence = collectPrEvidence({ repo, prNumber });
  const receipt = buildReceipt(evidence, { taskId });
  const json = JSON.stringify(receipt, null, 2) + '\n';
  if (outFile) writeFileSync(outFile, json);
  else process.stdout.write(json);
  if (!receipt.evidence_complete) {
    console.error(`note: evidence incomplete (recommendation=${receipt.recommendation})`);
  }
} catch (e) {
  console.error(`collect-evidence failed: ${e.message}`);
  process.exit(1);
}
