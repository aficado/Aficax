---
name: refactoring
description: Restructure existing code to improve clarity, reuse, or extensibility without changing observable behaviour.
tools: [read_file, grep, glob, edit_file, write_file, bash]
triggers:
  - "refactor"
  - "refactoring"
  - "clean up"
  - "reorganize"
  - "extract"
  - "rename"
  - "refactoriza"
always: false
---

# Refactoring

A refactor changes *how* the code is organised without changing *what* it does. If the user wants new behaviour, that is a feature, not a refactor.

## 1. Confirm scope and motivation

Ask (or infer from the message) what the user is trying to improve:
- **Readability**: the code is hard to follow.
- **Reuse**: the same logic appears in N places.
- **Extensibility**: adding the next case is awkward.
- **Testability**: the code resists unit tests.
- **Performance**: hot-path allocation, repeated work.

Each motivation leads to a different refactor. Don't rename variables to "improve readability" when the real problem is a 200-line function that should be split.

## 2. Establish a safety net

Before changing anything:
- Run the existing test suite. If it passes, commit it as a checkpoint (`git stash` or `git commit`).
- If the suite is missing or thin, write the *characterisation tests* first: tests that pin the current behaviour so you can detect regressions. This is not optional.
- For the hot path, capture a `console.time` / `hyperfine` baseline so you can compare against it later.

## 3. Make atomic, reversible changes

The diff should be a sequence of small, individually-revertible commits:

1. **Rename** for clarity. Tools do this well (TypeScript Language Service, `go rename`, `rust analyzer`). Always rename *first*; the rest of the refactor is much easier when the names are right.
2. **Extract** a helper, a constant, or a type.
3. **Inline** anything that is now obviously trivial.
4. **Move** to a more appropriate module.
5. **Split** a large function / file into smaller units with single responsibilities.

Run the test suite after each step. If a step fails, revert it and learn from the failure before trying again.

## 4. Preserve observable behaviour

A refactor MUST NOT change:
- Public APIs (signatures, error types, return values).
- Side effects (order of I/O, what is logged, what is written to disk).
- Performance characteristics by more than noise (≈5 %).

If you find yourself wanting to "also fix this small bug" or "also rename this for consistency" during a refactor, do it in a *separate* commit so the refactor PR stays reviewable.

## 5. Verify

- Full test suite green.
- Diff stat: smaller or equal lines per file is the goal; net positive lines means you added complexity.
- Linter / formatter clean.
- Benchmark: same or better than baseline.
- Optional: skim the diff with `git diff main...HEAD` and ask "if I were reviewing this PR, would I understand why each line changed?"

## Anti-patterns

- **Mega-refactor**: don't try to clean up an entire codebase in one PR. The blast radius is too large to review and too hard to revert.
- **Refactor without tests**: if the suite is green only by accident, you have no safety net.
- **Refactor as a side-effect of a feature**: the feature PR and the refactor PR have different review audiences. Split them.
- **"Cleanup" commits that mix rename, extract, and reformat**: impossible to review. One kind of change per commit.
