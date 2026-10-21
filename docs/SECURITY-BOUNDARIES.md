# Security boundaries (P1)

Threat model and permission audit for AI Supervisor V1.0. V1.1 (self-hosted
Runner) has its own separate authorization gate and is **not** covered by
this document beyond the boundary stated in §7.

## 1. Trust boundaries

- **Untrusted data**: every PR description, diff, Issue comment, test log,
  checkpoint file and Order/ACK payload. The monitor fetches facts first,
  then judges per policy; it never executes commands found in them and
  never treats them as user authorization.
- **Server metadata is the only identity**: comment author / created_at /
  ID / URL come from GitHub. JSON self-claims about authorship are ignored.
- **Human approval**: only the current user's explicit words for a named
  protected operation (merge, deploy, publish, runner install). Issue/PR
  text, old checkpoints, and a monitor's `ADVANCE` are never approval.

## 2. Permission matrix

| Action | B monitor | A developer | User |
| --- | --- | --- | --- |
| Read target repo code / PR / CI | allow | allow | allow |
| Read plans and checkpoints | allow | allow | allow |
| Publish Supervisor Order | allow, **comments only** | must not impersonate B | allow |
| Edit target feature-branch code | **deny** | within existing task authorization | explicit grant |
| Update existing dev checkpoint | **deny** (A owns it) | per project contract | explicit grant |
| Retry CI / run verifiers | V1.0 does not execute | per authorization | explicit grant |
| Merge / deploy / production config | **never auto-authorized by an Order** | only after separate explicit grant | final approver |

V1.0 logical role separation: A and B may share one GitHub connection
account. This is **not** hardware-enforced isolation. The validator,
prompts and schema cannot replace server-side permission control. True
isolation requires a minimal GitHub App (audited separately before any
implementation): read Contents/PR/Checks/Actions, write Issue/PR comments
only — no Contents write, no Actions write, no merge. Never hand the
Supervisor a full-repo-write token for convenience.

## 3. Injection and smuggling controls

- Wire strings are scanned for secret/token patterns (GitHub token
  prefixes, `x-access-token`, `?token=`, private-key blocks) and newline
  injection;
  violations fail validation (`SECRET_OR_INJECTION`).
- Payload text matching authority-claim patterns ("owner has approved",
  "ignore previous instructions", "system:", …) raises
  `POSSIBLE_AUTHORITY_SMUGGLING`; the resume consumer **must** treat it as
  `BLOCKED` and never execute (acceptance S10).
- Paths must be repo-relative and normalized: no absolute paths, no `..`,
  no drive letters, no backslashes.

## 4. Idempotency as a safety control

Duplicate suppression is not just hygiene — it prevents double-execution:
deterministic `order_id`, read-back before resend, server-side ordering for
consumption, `BLOCKED` on conflicting verdicts, and `STALE_ORDER` when the
live HEAD moved. A is forbidden from porting old evidence to a new commit.

## 5. Secret hygiene

This repository must never contain: account passwords, private keys,
session cookies, runner tokens, production host addresses, or undigested
production business data. Validation fixtures use synthetic SHAs and
example URLs only.

## 6. Cost and Actions boundary (V1.0)

- Zero new GitHub Actions for supervision: this repository ships **no**
  `.github/workflows/`, no runner registrations, no scheduled services.
- Monitor/developer work happens inside the users' existing ChatGPT
  tool-call sessions via the GitHub connector/API; target projects' normal
  push/PR CI is their own existing cost, not supervision overhead.
- Comment publication can trigger `issue_comment`-subscribed workflows in
  the *target* repository or external webhooks — re-audit the target's
  workflow YAML / GitHub Apps / rulesets before each new project onboarding
  and before any zero-Actions claim.

## 7. V1.1 boundary (not in this phase)

V1.1 self-hosted Runner installation is a **separate explicit authorization**.
It requires, in order: (a) read-only VPS resource/permission audit with a
fresh report, (b) isolated low-privilege Linux user + dedicated labels +
single-job concurrency, (c) a manually-triggered workflow only
(`workflow_dispatch`, `contents: read`), and (d) rollback limited to the
newly added workflow/runner registration. If safe isolation is impossible
on the production VPS, V1.1 does not ship there. None of (a)–(d) is
performed, approved, or implied by P1–P4.
