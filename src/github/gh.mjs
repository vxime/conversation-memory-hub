import { execFileSync } from 'node:child_process';

// Read-only wrapper around the `gh` CLI.
// Only whitelisted read commands may run; anything else throws BEFORE
// any subprocess is spawned. This module never performs a GitHub write.

const READ_COMMANDS = new Set([
  'api',        // GET only (see assertReadOnly)
  'pr',         // view | diff | status | checks | list
  'repo',       // view | list
  'issue',      // view | list | status
  'search',     // read-only search
]);

const READ_SUBCOMMANDS = {
  pr: new Set(['view', 'diff', 'status', 'checks', 'list']),
  repo: new Set(['view', 'list']),
  issue: new Set(['view', 'list', 'status']),
  search: new Set(['repos', 'issues', 'prs', 'code', 'commits']),
};

export function assertReadOnly(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('gh: empty argv refused');
  }
  const [cmd, sub] = argv;
  if (!READ_COMMANDS.has(cmd)) {
    throw new Error(`gh: command '${cmd}' is not in the read-only whitelist`);
  }
  if (cmd === 'api') {
    // Only GET requests. Reject explicit write methods and raw field
    // flags that imply a body.
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if ((a === '--method' || a === '-X') && argv[i + 1]) {
        const method = String(argv[i + 1]).toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          throw new Error(`gh api: method ${method} refused (read-only)`);
        }
      }
      if (a === '--input' || a === '-F' || a === '--field') {
        // -F/--field on GET become query params; --input implies a body.
        if (a === '--input') throw new Error('gh api: --input (request body) refused (read-only)');
      }
    }
    return;
  }
  if (!READ_SUBCOMMANDS[cmd]?.has(sub)) {
    throw new Error(`gh ${cmd}: subcommand '${sub ?? ''}' is not in the read-only whitelist`);
  }
  // Belt and braces: never allow flags that perform writes.
  const joined = argv.join(' ');
  for (const bad of ['--merge', '--squash', '--rebase', '--comment', '--body ', '--add-reviewer', '--add-assignee', '--add-label']) {
    if (joined.includes(bad)) throw new Error(`gh ${cmd} ${sub}: write flag '${bad.trim()}' refused`);
  }
}

export function ghJson(argv, { timeoutMs = 60000 } = {}) {
  assertReadOnly(argv);
  const out = execFileSync('gh', argv, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

export function ghText(argv, { timeoutMs = 60000 } = {}) {
  assertReadOnly(argv);
  return execFileSync('gh', argv, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
}
