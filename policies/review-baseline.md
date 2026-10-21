# Review baseline policy (P1)

The minimum evidence set for an independent technical review before any
Supervisor Order is published. Derived from the implementation plan §4.4.

1. **Locate the task**: Issue/PR, implementation plan, checkpoint, allowed
   scope. Read the actual feature branch — never review from memory or from
   a chat transcript.
2. **Review the patch** against the plan and acceptance criteria, including
   affected call chains, side effects and rollback paths. Record findings as
   `BLOCKER` / `MAJOR` / `MINOR`. "Looks fine" is not a review.
3. **Verify the current PR HEAD**: base, changed files, full patch when
   needed. A review of an older diff does not transfer to a newer commit.
4. **Check CI on the current SHA**: query workflow runs / check runs /
   check suites for the *current* SHA and the *latest attempt*; match the
   real required check names and conclusions. Empty legacy combined status
   is not "no failures".
5. **Report the layer separately**: code complete / locally tested / CI
   complete / merged / deployed are different claims. Never conflate them.
6. **Re-read HEAD immediately before publishing**; if it moved, stop the
   old Order and re-review (or publish `BLOCKED`). After publishing, read
   back the comment's GitHub ID and body.

Conservative defaults (missing evidence is never PASS):

- Required CI queued/in_progress/skipped/cancelled/unknown → not PASS.
- Green CI on an old HEAD → not evidence for the current HEAD.
- Incomplete comment pagination → stop, record `BLOCKED`.
- API errors, rate limits, missing permissions → fail closed, keep evidence,
  do not silently retry external writes.
- Any `BLOCKER`/`MAJOR` finding → `FIX_REQUIRED`, never `ADVANCE`.
