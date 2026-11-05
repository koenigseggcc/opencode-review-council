---
description: Give the full council follow-up feedback after a prior review
---
The user is giving the council further feedback after a prior review. User arguments: $ARGUMENTS

Call the `council_followup` tool once with the user's feedback:
- feedback: the feedback verbatim. If it refers to findings from the previous report, include their titles and `file:line` locations so the fresh reviewers know what it refers to.

The tool re-runs the full three-model council on the same target as the prior run in this
session, passing the feedback to every reviewer. If it reports that no council has run in
this session, relay that and tell the user to run `/council` first. Do not review the code
yourself; relay the new council report as-is.
