---
name: code-review
description: Review code for correctness, security, performance, and maintainability before merge.
tools: [read_file, grep, glob, bash]
triggers:
  - "review code"
  - "code review"
  - "revisa código"
  - "revisar cambios"
  - "look at this PR"
  - "check this diff"
always: false
---

# Code Review

When the user asks you to review code (a PR, a diff, a file, or a set of changes), follow this procedure.

## 1. Scope

Clarify what is being reviewed:
- A specific PR / branch (`gh pr diff <num>`)
- The working tree (`git diff`, `git diff main...HEAD`)
- A specific file or directory (`read_file` on each)
- An arbitrary paste

Default to the working tree if the user did not specify.

## 2. Read with intent

- Skim first to understand the *shape* of the change: which files, how many lines, what modules touched.
- Read the tests first. The tests tell you what behaviour the author was trying to change.
- Read the actual diff with the surrounding context (at least 20 lines around each hunk) so you can judge whether the change is consistent with the rest of the file.

## 3. Evaluate in this order

### Correctness
- Does the code do what the commit message and tests claim?
- Are there off-by-one, null-check, race-condition, or boundary issues?
- Are async operations awaited correctly? Are errors handled, swallowed, or surfaced?
- Is the new code reachable from the entry point that actually needs it?

### Security
- Are inputs validated at the trust boundary?
- Any string-concatenated SQL / shell / HTML?
- Are secrets, tokens, or PII being logged or echoed back?
- Are permission / authorisation checks present where they are needed?

### Performance
- Any O(n²) or O(n!) loops where O(n) or O(n log n) would do?
- Are queries indexed? Are N+1 queries possible?
- Hot path: will this allocation, regex, or I/O fire on every call?

### Maintainability
- Does the new code follow the conventions of the file / module / project?
- Is there a simpler refactor that preserves behaviour?
- Are names specific (`getUserById` beats `handle`)?
- Is the abstraction at the right level? Too high (over-general) and too low (leaky) are both smells.

### Tests
- Do the new tests actually exercise the new behaviour?
- Are edge cases covered (empty input, null, large input, concurrent access)?
- Is there a test that would fail if the change is reverted? (Good test.) Or one that passes either way? (Bad test.)

## 4. Format your review

Use the project's PR-template if there is one. Otherwise:

```
## Summary
<one-paragraph overall verdict: approve / request changes / comment>

## Correctness
- ...

## Security
- ...

## Performance
- ...

## Maintainability
- ...

## Tests
- ...

## Nitpicks (optional)
- ...
```

For every blocking issue, name the file and line. For every nit, prefix it with `nit:` so the author can batch-fix or ignore.

## 5. What NOT to do

- Don't comment on style that the project's linter should have caught.
- Don't demand rewrites for things that work — only flag when a refactor is clearly worth it.
- Don't approve without reading the tests.
- Don't add comments about your own behaviour ("I checked the docs…"). The review is the artefact.
