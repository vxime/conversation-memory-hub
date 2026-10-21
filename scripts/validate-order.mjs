#!/usr/bin/env node
// Validate a Supervisor Order (or ACK) JSON file offline.
// Usage: node scripts/validate-order.mjs <order.json> [--ack]
// Exit 0 = valid; exit 1 = invalid (errors printed as JSON).
import { readFileSync } from 'node:fs';
import { validateOrder } from '../src/protocol/validate-order.mjs';
import { validateAck } from '../src/protocol/validate-ack.mjs';

const file = process.argv[2];
const isAck = process.argv.includes('--ack');
if (!file) {
  console.error('usage: node scripts/validate-order.mjs <order.json> [--ack]');
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(JSON.stringify({ valid: false, errors: [{ code: 'JSON_PARSE', path: '', message: e.message }], warnings: [] }, null, 2));
  process.exit(1);
}

const result = isAck ? validateAck(payload) : validateOrder(payload);
console.log(JSON.stringify(result, null, 2));
process.exit(result.valid ? 0 : 1);
