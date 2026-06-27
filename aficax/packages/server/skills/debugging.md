---
name: debugging
description: Diagnose a bug systematically: form a hypothesis, gather evidence, isolate the cause, then fix.
tools: [read_file, grep, glob, bash, write_file, edit_file]
triggers:
  - "debug"
  - "bug"
  - "not working"
  - "doesn't work"
  - "failing"
  - "investigá"
  - "investiga"
  - "por qué falla"
always: false
---

# Debugging

When the user reports a bug ("X doesn't work", "Y fails", "I see Z in the logs"), follow this procedure. Do not jump to a fix before you understand the failure.

## 1. Reproduce

Get the bug down to a deterministic, minimal repro:
- The smallest input / command that triggers it.
- The exact error message, stack trace, or unexpected output.
- Whether it is deterministic or flaky (and if flaky, what correlates with the failure).

If you cannot reproduce in a few minutes, ask the user for the exact reproduction steps or a sample payload. Do not invent a fix for a bug you have not seen.

## 2. Form hypotheses

List 2–4 plausible causes, ordered by likelihood. For each, state what evidence would confirm or refute it. The goal is to make the next debugging step *information-rich* — a step that can confirm/refute a hypothesis is worth 10 random `console.log` insertions.

Common hypothesis categories:
- **Data**: is the input what you think it is? (Type, encoding, null, empty.)
- **State**: is the system in the state you think it is? (Cache, env var, working directory, running process.)
- **Control flow**: does the code path actually reach the line you suspect?
- **Concurrency**: is there a race? An order-of-operations bug?
- **Environment**: version mismatch, missing dependency, wrong branch.

## 3. Gather evidence

Add the smallest, most-targeted instrumentation that distinguishes between the hypotheses. Examples:

```ts
// Before
const result = parse(input);
return result.value;

// After
const result = parse(input);
console.error('[debug parse]', { input, result, ts: Date.now() });
return result.value;
```

When logging, log structured objects (not concatenated strings) so the format is grep-friendly. Strip the logs after the fix, or gate them behind a debug flag.

## 4. Isolate

Bisect:
- A binary search through `git log -S '<symbol>'` for when the bug was introduced.
- A binary search through the input (which part triggers it?).
- A binary search through the code (which line starts the wrong behaviour?).

The first moment the observed state diverges from the expected state is the root cause. Stop bisecting as soon as you have it.

## 5. Fix

- Make the smallest change that fixes the root cause. Do not refactor the surrounding code.
- Add a regression test that fails on the old code and passes on the new code.
- Run the test, plus the full suite, to confirm no regressions.

## 6. Explain

Tell the user:
- What the root cause was.
- Why the fix addresses it.
- Whether there are other places with the same bug (grep for it).
- Anything that surprised you about the failure mode.

## Anti-patterns

- **Changing many things at once** to see if any of them fixes the bug. You will not know which change fixed it.
- **Restarting the service** to "fix" a non-deterministic bug. Document the flake; do not paper over it.
- **Adding a try/catch that swallows the error** to make the symptom go away. The bug is still there; you just made it invisible.
- **Blaming the framework** without evidence. Frameworks have bugs, but yours is more likely.
