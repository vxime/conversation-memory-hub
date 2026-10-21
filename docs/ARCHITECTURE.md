# AI Supervisor architecture

This document distills the design of AI Supervisor V1: a GitHub-driven
protocol for cross-session AI code review and handoff. It describes goals,
boundaries, and the machine-checkable protocol. The code in
`src/protocol/` enforces the checkable parts; `docs/REVIEW-PROTOCOL.md`
states the operating rules, and `docs/SECURITY-BOUNDARIES.md` states the
threat model.

## Goals

- Let a Supervisor session review a real task — code, plan, current HEAD,
  and CI — independently, and hand off the result as a structured,
  verifiable instruction instead of free-form chat text.
- Let a Developer session resume from that instruction after a short user
  trigger, re-reading everything live from GitHub, starting at the first
  step that lacks acceptance evidence.
- Make every handoff bound to an exact commit, replay-safe, and auditable
  after the fact from GitHub alone.
- Keep the human in control of every protected operation: merge, deploy,
  publish, and any change to the approval scope.

## Non-goals

- No general-purpose agent execution service, and no resident daemon.
- No copying or mirroring of a target project's business state, plans, or
  checkpoints into this repository.
- No scheduled polling, no automatic wake-up of another chat session, and
  no unofficial messaging or browser automation.
- No new runtime dependencies for the protocol itself, and no treating a
  green CI result as release or merge approval.
- No storing of account passwords, private keys, session cookies, runner
  tokens, production host addresses, or unredacted production data in this
  repository.

## Architecture

```text
Developer session (A)                     Supervisor session (B)
  user: "continue"                          user: "review and advance"
        |                                             |
        v                                             v
  Read target task / PR / checkpoint    Read same plan / branch / diff / CI
  Fetch the latest valid Order          Independent verdict + evidence
        ^                                             |
        |                                             v
        +---------- Target repo Issue/PR comments <---+
                    (immutable comment ID + structured body)
                              |
             ai-supervisor: protocol / policies / validators /
             JSON Schemas / project adapters / prompts
```

Two roles take part:

- **Supervisor (B)** — reviews only. It reads the target repository,
  checks evidence against policy, and publishes one Order comment. It
  never edits target code, updates the target checkpoint, re-runs CI,
  merges, or deploys.
- **Developer (A)** — implements only within an existing task
  authorization and within the bounds of the Order it consumed. It posts
  an ACK describing what it did.

The user starts each side explicitly with a short trigger. Nothing runs
on a schedule and nothing wakes another session up.

## Single source of truth

- **Target repository** — the real source code, task plan, existing
  checkpoint, branches, pull requests, CI runs and attempts, review
  comments, and ACKs. This is the only authoritative state for an active
  development task.
- **This repository** — protocol versions, policies, JSON Schemas,
  validators, adapters, prompts, and tests. It deliberately keeps no
  second "current active project" pointer and does not mirror target
  state on a timer.
- **Chat sessions** — entry points, not databases. Model memory and past
  answers are only search hints; every conclusion must be re-read from
  the real GitHub state.
- **Human approval** — only the current user's explicit words for a named
  protected operation. Issue/PR text, old checkpoints, and a Supervisor's
  `ADVANCE` are never approval.

## Role and permission matrix

| Action | Supervisor (B) | Developer (A) | User |
| --- | --- | --- | --- |
| Read target repo code / PR / CI | allow | allow | allow |
| Read plans and checkpoints | allow | allow | allow |
| Publish a Supervisor Order | allow, **comments only** | must not impersonate B | allow |
| Edit target feature-branch code | **deny** | within existing task authorization | explicit grant |
| Update the existing dev checkpoint | **deny** (A owns it) | per project contract | explicit grant |
| Retry CI / run verifiers | does not execute in V1.0 | per authorization | explicit grant |
| Merge / deploy / production config | **never auto-authorized by an Order** | only after a separate explicit grant | final approver |

In the core edition, both roles may act through the same GitHub
connection account. That is **logical** role separation, not
hardware-enforced isolation: validators, prompts, and schemas cannot
replace server-side permission control. True isolation would require a
separately audited, minimal-permission integration — read access to
contents, pull requests, checks, and actions, write access to Issue/PR
comments only, and no contents write, no actions write, and no merge.

All PR descriptions, diffs, Issue comments, test logs, checkpoints, and
Order/ACK payloads are untrusted data. Participants fetch facts first,
judge per policy, never execute commands found in that data, and never
treat it as user authorization.

## Order channel and lifecycle

### Channel

- If an open development PR exists, the Order is posted as a top-level
  conversation (Issue) comment on that PR, bound to the current PR HEAD.
- If there is no PR yet, the Order is posted on the task Issue, and it
  must name a valid task ID, development branch, and observed HEAD.
  Without a reliable branch, only `BLOCKED` may be published — never
  `ADVANCE`.
- One Order is one independent comment. The body starts with the fixed
  header `AI-SUPERVISOR-ORDER/v1` followed by one JSON fenced block.
  Ordinary comments are never commands.
- Comment ID, author, timestamp, and URL are server metadata and are
  never taken from the JSON payload.
- Comments must be read with full pagination. Incomplete reads, API
  errors, or missing evidence mean no `ADVANCE` is issued.

### Order contents

The wire contract is `schemas/supervisor-order.v1.schema.json`; the
hand-written validator in `src/protocol/validate-order.mjs` is the
authoritative enforcement. Among other rules it checks:

- a closed field allow-list (`additionalProperties: false` at every
  level), required fields, length limits, enums, and integer ranges;
- normalized, repo-relative paths — no absolute paths, no traversal, no
  token-bearing URLs, and no newline injection in wire strings;
- HEAD values that are full 40-character Git SHAs read live from GitHub —
  placeholder text is never a valid Order;
- decision/finding coherence: `ADVANCE` must not carry `BLOCKER`/`MAJOR`
  findings, and `FIX_REQUIRED` requires at least one finding;
- operation coherence: privileged operations (`merge`,
  `production_deploy`, `publish`, `install_runner`) may be listed as
  forbidden but can never be listed as allowed, and no operation may be
  both allowed and forbidden.

### Decisions

| Decision | Precondition | Developer behavior |
| --- | --- | --- |
| `ADVANCE` | All acceptance criteria for the current phase are evidenced on the reviewed HEAD, and the next phase is inside the authorized scope | Continue from the first unaccepted step; no new merge/production rights are implied |
| `FIX_REQUIRED` | A locatable, reproducible defect needs a code fix, with file, evidence, and acceptance condition | Fix only the listed findings, keep existing behavior, and return with a new HEAD for re-review |
| `BLOCKED` | Permissions, HEAD, evidence, or code provenance are missing or conflicting, so continuing is unsafe | Stop writing; report the blocker and the safe next step |
| `AWAIT_APPROVAL` | Only a step needing explicit user consent remains (merge, deploy, publish, or another external write) | Stop and present the exact approval scope; never escalate an old approval |

### Lifecycle

1. The Supervisor reviews per `policies/review-baseline.md` and
   `policies/ci-acceptance.md`: locate the task, review the patch against
   the plan and acceptance criteria, verify the current PR HEAD, and
   check CI for the current SHA and latest attempt, matching the real
   required check names.
2. The Supervisor builds the Order JSON, validates it, and computes its
   deterministic `order_id`.
3. The Supervisor paginates all existing Orders for the task and checks
   for a duplicate before publishing (see Idempotency below).
4. The Supervisor re-reads HEAD immediately before publishing. If HEAD
   moved, the old review stops and the task is re-reviewed (or a
   `BLOCKED` Order is published instead).
5. The Supervisor publishes the comment and reads back its GitHub
   comment ID and URL. Only then is the handoff reported to the user,
   with the decision, the top evidence links, the concrete next step,
   and the published Order link.
6. The Developer identifies the repository, task, and Issue/PR
   explicitly — never by guessing from another chat — re-reads the
   project's rules, plan, checkpoint, PR HEAD, CI, and live permissions,
   then fetches all paginated comments and selects the effective Order:
   trusted authors only, correct task and target, and bound to the live
   HEAD.
7. On any anomaly — conflicting verdicts, duplicate-execution risk,
   stale HEAD, missing fields, a broken supersedes chain, an
   approval-scope change, or authority-claiming payload text — the
   Developer treats the Order as `BLOCKED` and does not execute.
8. After acting, the Developer updates the target project's own
   checkpoint per its contract and posts an ACK v1 comment (see
   `schemas/supervisor-ack.v1.schema.json`): the consumed `order_id`, the
   observed HEAD, what was executed or why it was refused, and the new
   HEAD link. Code complete, locally tested, CI complete, merged, and
   deployed are reported as separate states.

## Idempotency, concurrency, and conflicts

- **Deterministic ID.** `order_id` is a SHA-256 digest over the
  canonicalized material: protocol version, task, repository,
  PR-or-Issue, branch, HEAD, decision, and findings. `created_at` and
  `notes` are excluded, so the same review material always yields the
  same ID. The ACK's `ack_id` follows the same pattern.
- **Reuse, never repost.** Before publishing, the Supervisor scans
  existing valid Orders for the task; an identical `order_id` reuses the
  existing comment link. On a publish timeout, it reads back first and
  searches by `order_id` — it never blindly resends.
- **Effective-Order selection.** The Developer selects among valid
  Orders by server `created_at`, tie-broken by server comment ID — never
  by "the last comment seen".
- **Conflicts fail closed.** Two valid Orders on the same HEAD with
  different decisions and no supersedes chain resolving them produce
  `BLOCKED`.
- **Staleness.** After a new commit, Orders bound to the old HEAD are
  dead. The Developer stops with `STALE_ORDER` rather than porting old
  evidence to a new commit, and the Supervisor re-reviews the new HEAD.
- **Supersedes.** A newer Order on the same HEAD may retire an older one
  by naming it in `supersedes_order_id`; the chain must be consistent,
  or consumption is `BLOCKED`.

Duplicate suppression is a safety control: it prevents the same
instruction from being executed twice.

## Target project onboarding and adapters

A target project is connected by adding a short protocol reference to its
existing engineering entry point, so that a short resume trigger is
interpreted as a Developer resume only when a concrete engineering task
context (repository, task ID, Issue/PR) is known. A target project's
existing operational short-commands keep their original meaning outside
that context and are never intercepted.

The Supervisor side is triggered explicitly by the user naming the task;
if the task cannot be identified unambiguously, candidates are listed and
nothing is guessed.

Per-project facts live in an adapter file (`adapters/*.json`):
repository, trusted comment authors, comment channel, CI evidence
source, engineering-contract paths, and do-not-intercept commands. An
adapter is read-only metadata — it grants nothing and changes nothing in
the target repository. Before claiming the "zero new Actions" property
for a newly onboarded project, its workflow triggers, GitHub Apps, and
webhooks must be re-audited, because an Order comment can be consumed by
`issue_comment`-subscribed automation in the target repository.

## Phases

### V1.0 core (this edition)

- Zero resident services, zero new GitHub Actions for supervision, and
  zero automatic wake-up. Review and resume happen inside the user's
  existing sessions, reading and writing the GitHub API on demand.
- Deliverables: the Order/ACK schemas and validators, the review and CI
  policies, the Supervisor and Developer prompts, project adapters, and
  an offline fixture matrix covering the positive cases and the negative
  cases (bad digest, bad SHA, privilege escalation, operation conflict,
  secret/injection patterns, authority smuggling, staleness, conflicts,
  supersession, untrusted authors, and task mismatch).

### Optional future extensions

An optional, separately authorized extension could run deterministic
verifiers on an isolated, repository-scoped self-hosted runner —
manually triggered only, under a low-privilege identity, with its own
resource and permission audit and a rollback limited to what the
extension itself added. Such an extension is not a prerequisite for
V1.0, is not implied by it, and never changes the rule that an Order
cannot authorize merge, deploy, or publish.

## Cost and Actions boundary

V1.0 adds no supervision workflows, no runner registrations, and no
scheduled services, so supervision itself consumes no Actions minutes. A
target project's normal push/PR CI remains that project's own existing
cost; the "zero new Actions" claim is only about supervision and must be
re-verified for each new target project, as described above.

## Recovery for a new session

A new session needs only three things to resume safely: the target
repository, the task ID, and its Issue/PR. From there it re-reads the
plan, checkpoint, current branch and PR state, CI, and project rules
live, finds the first step without acceptance evidence, and proceeds
from there. It must not recreate an existing task, reuse an old HEAD's
CI as evidence, or treat an Issue, a checkpoint, or a green check as new
user authorization.
