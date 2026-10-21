# CI acceptance policy (P1)

Rules for interpreting GitHub Actions evidence inside a Supervisor Order.
A check is only evidence when it is bound to the reviewed HEAD.

1. **Name matching**: the required check names come from the real
   repository (branch protection / workflow definitions read live), never
   from memory or from the PR description.
2. **SHA binding**: `evidence.ci.head_sha` must equal
   `target.observed_head_sha` must equal the branch HEAD read from GitHub
   at review time. Anything else is stale evidence.
3. **Attempt binding**: use the latest attempt's conclusion. A re-run that
   is still queued does not inherit the previous attempt's result.
4. **Status mapping** (acceptance matrix):
   - `SUCCESS` → may support `ADVANCE` (with all other evidence).
   - `FAILED` → `FIX_REQUIRED` (with findings).
   - `QUEUED` / `IN_PROGRESS` → not PASS (S02).
   - `SKIPPED` / `CANCELLED` / `UNKNOWN` → not PASS (S04).
   - green on an older SHA → not evidence (S03).
5. **The read-only reviewer never re-runs CI.** Retrying workflows is an
   external write outside the V1.0 review role; only the developer (A)
   within an authorized scope, or the user, may do it.
6. **Missing data is not PASS**: empty check lists, pagination gaps, API
   errors and rate limits produce `BLOCKED` with the gap recorded — never
   an assumed green.
7. **No conflation**: "CI passed" is not merge approval, not deploy
   approval, and not a license to change the approval scope (S20).
