---
description: Convene the 3-model review council
---
Convene the code-review council. User arguments: $ARGUMENTS

Call the `council` tool exactly once:
- request: the review target the user named: a PR number, a git ref or range like `main...HEAD`, or file paths. When a bare path or directory exists in the repository (for example `council-review`), pass it as the review scope in request. A bare number is a PR number unless a path with that name exists.
- focus: additional review guidance for the reviewers (what to pay attention to), separate from the review target.
If there are no arguments, call the tool with no request (it defaults to the working-tree diff).

The council reviews the code. Relay its report to the user as-is.
