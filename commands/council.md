---
description: Convene the 3-model review council
---
Convene the code-review council. User arguments: $ARGUMENTS

Call the `council` tool exactly once:
- request: the review target if the user named one (PR number, git ref or range like `main...HEAD`, or file paths). A bare path or directory that exists in the repository (for example `council-review`) is a request (review scope), never focus. A bare number is a PR number unless a path with that name exists.
- focus: only additional review guidance for the reviewers (what to pay attention to), never the review target itself.
If there are no arguments, call the tool with no request (it defaults to the working-tree diff).

Do not review the code yourself; the council does that. Then relay the council's report to the user as-is.
