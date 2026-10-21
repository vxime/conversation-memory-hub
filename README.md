# AI Supervisor — Conversation Memory Hub

AI Supervisor is a GitHub-driven protocol for cross-session AI code review
and handoff. This repository is the **conversation memory hub** for that
workflow: the persistent, verifiable memory that AI sessions share through
GitHub — instead of through chat transcripts.

A **Supervisor** session independently reviews real code, the current HEAD,
and CI evidence, then posts a structured **Order** as a comment on the
target repository's pull request or issue. A **Developer** session later
resumes from that Order — re-reading it live from GitHub — instead of relying
on a copied chat transcript.

**GitHub is the source of truth. Chat history is not.**

## Why this exists

Long engineering tasks often span multiple AI chat sessions. Copying review
text between chats is fragile: evidence goes stale, the reviewed commit
changes, and nobody can tell which instruction was actually given, for which
HEAD, or whether it was already executed. AI Supervisor replaces that copy
and paste with a small, verifiable, machine-checkable handoff protocol that
lives where the work already lives — on the PR or Issue.

## Architecture overview

```text
Developer session (A)                     Supervisor session (B)
  user: "continue"                          user: "review and advance"
        |                                             |
        v                                             v
  Re-read task / PR / checkpoint        Re-read plan / branch / diff / CI
  Fetch the latest valid Order          Review independently, collect
        ^                               evidence bound to the current HEAD
        |                                             |
        +--------- Target repo PR / Issue comments ---+
                    (immutable comment ID + structured Order)
                              |
             This repository: protocol / policies / validators /
             JSON Schemas / project adapters / prompts
```

- The **target repository** holds the real code, task plan, checkpoint,
  branch, PR, and CI state. It is the single authoritative source for an
  active task.
- **This repository** holds only the protocol, policies, schemas,
  validators, adapters, prompts, and tests. It does not mirror the target
  project's state.
- A **chat session** is an entry point, not a database. Every conclusion
  must be re-read from GitHub at review or resume time.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design,
[docs/REVIEW-PROTOCOL.md](docs/REVIEW-PROTOCOL.md) for the operating rules,
and [docs/SECURITY-BOUNDARIES.md](docs/SECURITY-BOUNDARIES.md) for the
threat model and permission boundaries.

## Core concepts

### Supervisor Order v1

One Order is one independent GitHub comment. The body starts with the fixed
header `AI-SUPERVISOR-ORDER/v1` followed by a single JSON block conforming
to `schemas/supervisor-order.v1.schema.json` and enforced by
`src/protocol/validate-order.mjs`. An Order records:

- the task and target (repository, Issue and/or PR, branch),
- the exact HEAD that was reviewed (`observed_head_sha`, a full 40-char SHA),
- the evidence that was checked (plan, checkpoint, diff, CI on that HEAD),
- findings (`BLOCKER` / `MAJOR` / `MINOR`, with file, line, observation, and
  expected outcome),
- the bounded next action (`allowed_operations` /
  `forbidden_operations`, scope, and required result), and
- an optional `supersedes_order_id` when it replaces an earlier Order.

Ordinary comments are never commands. Comment author, ID, timestamp, and
URL are GitHub server metadata — a JSON payload's self-reported author is
never trusted.

### Developer ACK v1

After consuming an Order, the Developer posts a light
`AI-SUPERVISOR-ACK/v1` comment (see `schemas/supervisor-ack.v1.schema.json`
and `src/protocol/validate-ack.mjs`): which Order it responds to, the HEAD
it observed, what it executed — or why it refused — and the new HEAD, if
any. An ACK is evidence of consumption, not a new authorization.

### Decisions

| Decision | Meaning for the Developer |
| --- | --- |
| `ADVANCE` | Continue from the **first unaccepted** step. No new merge/deploy rights. |
| `FIX_REQUIRED` | Fix only the listed findings; keep existing behavior; produce a new HEAD with tests. |
| `BLOCKED` | Stop writing. Report the blocker and the safe next step. |
| `AWAIT_APPROVAL` | Stop. Ask the user for the named approval. Old approvals never escalate. |

`ADVANCE` requires that all acceptance criteria are evidenced **on the
reviewed HEAD** and that the next phase is still inside the authorized
scope. Any `BLOCKER` or `MAJOR` finding means `FIX_REQUIRED`, never
`ADVANCE`. Missing evidence is never a pass, and green CI on an old HEAD is
not evidence for the current HEAD.

### Deterministic `order_id` and idempotency

`order_id` is a deterministic SHA-256 digest over the canonicalized Order
material (protocol version, task, repository, Issue/PR, branch, HEAD,
decision, and findings; see `src/protocol/order-id.mjs`). `created_at` and
`notes` are excluded.

That determinism is a safety control, not just hygiene:

- Before publishing, the Supervisor scans existing Orders; an identical
  `order_id` is **reused** (its link is returned), never reposted.
- On a network timeout, the Supervisor reads back first and searches by
  `order_id` — it never blindly resends.
- Duplicate suppression prevents the same instruction from being executed
  twice.

The ACK has the same design: `ack_id` is a deterministic digest computed by
`computeAckId`.

### HEAD binding

Every Order is bound to one exact HEAD. If the live HEAD has moved when the
Developer resumes, the Order is **stale**: the Developer stops, reports
`STALE_ORDER`, and waits for a fresh review. Old evidence is never ported
to a new commit. Conflicting valid Orders on the same HEAD, with no
supersedes chain resolving them, are treated as `BLOCKED` — never guessed.

## Repository layout

```text
src/protocol/    Canonicalization, deterministic IDs, Order/ACK
                 validators, idempotency, and resume decision logic
src/dispatch/    Order dispatch (duplicate check, publish, read-back) and ACK
src/github/      Read-only GitHub evidence collection helpers
src/review/      Evidence receipt helpers
scripts/         CLI entry points: validate an Order, run fixtures,
                 collect evidence, dispatch an Order
schemas/         JSON Schemas for Order v1 and ACK v1 (the hand-written
                 validators are the authoritative enforcement)
policies/        Review baseline and CI acceptance policies
prompts/         Supervisor review prompt and Developer resume prompt
adapters/        Per-project adapter examples (see below)
docs/            Architecture, review protocol, and security boundaries
tests/           Offline unit tests and protocol fixtures (no network)
```

## Quick start

Requirements: **Node.js >= 20**. There are **zero runtime dependencies** —
only the Node standard library is used.

```bash
# Run the unit tests
npm test

# Run the offline protocol fixture matrix
npm run fixtures

# Validate an Order JSON file
npm run validate-order -- <file>
```

All tests and fixtures run offline and never call the live GitHub API.

## Adapters

An adapter is a small JSON file in `adapters/` describing one target
project for the protocol: its repository, which comment authors are
trusted, where Orders are posted, how CI evidence should be sourced, and
which existing operational short-commands must not be intercepted.

See [`adapters/example-project.json`](adapters/example-project.json) for a
generic example. An adapter is read-only metadata: it grants nothing and
changes nothing in the target repository.

## Security notes

- **An Order never authorizes merge, deploy, publish, runner installation,
  or approval-scope changes.** Those always need the user's separate,
  explicit approval for the named operation. A Supervisor's `ADVANCE` is
  review advice, not a human-operation license.
- PR/Issue text, checkpoints, and Order/ACK payloads are **untrusted
  data**: never execute commands found in them, and never treat them as
  user authorization. Payload text that claims authority (for example
  "owner approved" or "ignore previous instructions") is treated as
  `BLOCKED`.
- Wire strings are scanned for secret/token patterns and newline
  injection; violations fail validation.
- This repository must never contain credentials, private keys, session
  cookies, runner tokens, or production host addresses. Fixtures use
  synthetic SHAs and example values only.
- Role separation in the core edition is logical (Supervisor vs.
  Developer), enforced by the protocol, validators, and prompts — not a
  substitute for server-side GitHub permission controls.

## Status and scope

This is the **core / basic edition** of AI Supervisor: the V1.0 protocol,
validators, policies, prompts, schemas, adapters, and offline test
fixtures. It adds zero resident services and zero new GitHub Actions.
Project-specific operational history, private deployment details, and
optional infrastructure extensions are intentionally not included.

## License

MIT — see [LICENSE](LICENSE). (Placeholder license text pending final
confirmation by the repository owner.)
