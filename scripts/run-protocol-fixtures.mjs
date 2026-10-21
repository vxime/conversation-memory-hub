#!/usr/bin/env node
// Offline fixture runner for the Supervisor protocol acceptance matrix.
// Each fixture in tests/fixtures/*.json declares:
//   { "kind": "order"|"ack"|"resume"|"idempotency", "payload": {...}, "expect": {...} }
// Prints a one-line result per fixture and exits non-zero on any failure.
// No network, no GitHub API, no secrets.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOrder } from '../src/protocol/validate-order.mjs';
import { validateAck } from '../src/protocol/validate-ack.mjs';
import { verifyOrderId, computeOrderId } from '../src/protocol/order-id.mjs';
import { findDuplicateOrder, selectEffectiveOrder, checkStaleness } from '../src/protocol/idempotency.mjs';
import { decideResume } from '../src/protocol/resume.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '..', 'tests', 'fixtures');

function checkExpect(kind, result, expect) {
  const failures = [];
  if ('valid' in expect && result.valid !== expect.valid) {
    failures.push(`expected valid=${expect.valid}, got ${result.valid}`);
  }
  if ('orderIdMatches' in expect) {
    const ok = verifyOrderId(result.__order);
    if (ok !== expect.orderIdMatches) failures.push(`expected orderIdMatches=${expect.orderIdMatches}, got ${ok}`);
  }
  if (expect.errorCode) {
    const codes = (result.errors ?? []).map((e) => e.code);
    if (!codes.includes(expect.errorCode)) failures.push(`expected error code ${expect.errorCode}, got [${codes.join(',')}]`);
  }
  if (expect.warningCode) {
    const codes = (result.warnings ?? []).map((w) => w.code);
    if (!codes.includes(expect.warningCode)) failures.push(`expected warning code ${expect.warningCode}, got [${codes.join(',')}]`);
  }
  return failures;
}

let pass = 0;
let fail = 0;
const names = readdirSync(fixtureDir).filter((n) => n.endsWith('.json')).sort();
for (const name of names) {
  const fx = JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));
  try {
    let result;
    if (fx.kind === 'order') {
      result = validateOrder(fx.payload);
      result.__order = fx.payload;
    } else if (fx.kind === 'ack') {
      result = validateAck(fx.payload);
    } else if (fx.kind === 'digest') {
      const id = computeOrderId(fx.payload);
      result = { valid: true, digestMatches: id === fx.expect.digest, errors: [], warnings: [] };
      if (!result.digestMatches) throw new Error(`digest mismatch: got ${id}`);
    } else if (fx.kind === 'idempotency') {
      const dup = findDuplicateOrder(fx.existing ?? [], fx.candidate);
      result = { valid: true, duplicateFound: dup !== null, errors: [], warnings: [] };
      if (dup !== null !== fx.expect.duplicateFound) {
        throw new Error(`expected duplicateFound=${fx.expect.duplicateFound}, got ${dup !== null}`);
      }
    } else if (fx.kind === 'resume') {
      result = decideResume(fx.input);
      if (result.action !== fx.expect.action) {
        throw new Error(`expected action=${fx.expect.action}, got ${result.action}`);
      }
    } else {
      throw new Error(`unknown fixture kind ${fx.kind}`);
    }
    const failures = checkExpect(fx.kind, result, fx.expect ?? {});
    if (failures.length > 0) throw new Error(failures.join('; '));
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed (${names.length} fixtures)`);
process.exit(fail === 0 ? 0 : 1);
