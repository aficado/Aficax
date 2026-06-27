---
name: test-generation
description: Generate unit, integration, or end-to-end tests that match the project's existing test conventions.
tools: [read_file, grep, glob, write_file, bash]
triggers:
  - "write tests"
  - "generate tests"
  - "add tests"
  - "unit test"
  - "test coverage"
  - "crear tests"
  - "escribir pruebas"
always: false
---

# Test Generation

When the user asks you to generate tests, follow this procedure.

## 1. Learn the conventions first

- Read the test directory and pick the most similar existing test file to the module you are testing. Mirror its style, imports, fixture names, and assertion library.
- Identify the test runner: `bun test`, `vitest`, `jest`, `pytest`, `go test`, `cargo test`. Read `package.json` / `pyproject.toml` / `Cargo.toml` to confirm.
- Identify the assertion library and any helpers (`expect(x).toEqual(y)`, `assert x == y`, `mustache`, etc.).
- Note the location convention (`src/foo.ts` ↔ `src/foo.test.ts`, `src/foo.py` ↔ `tests/test_foo.py`, etc.).

## 2. Build the test plan

For the function / class under test, list:

- **Happy path**: the most common inputs and the expected outputs.
- **Edge cases**: empty input, single-element input, very large input, the boundary between "valid" and "invalid".
- **Failure modes**: invalid types, malformed data, network errors, timeouts. Mock these.
- **State**: any state that persists across calls and must be reset between tests.

Skip a category only when it is genuinely not applicable (e.g. "happy path" for a pure formatter might be a single case).

## 3. Write the tests

- One `describe` / `class` per logical unit; one `it` / `test` / `def test_` per case.
- Use descriptive names that read as sentences: `it('returns null when the user is not found', ...)` beats `it('test1', ...)`.
- Use `beforeEach` / `setUp` to reset state; never let one test's side effects leak into the next.
- For pure functions, prefer table-driven tests when the runner supports it (Jest's `it.each`, pytest's `parametrize`, Go's sub-tests).
- For async code, `await` the result and assert on the resolved value, not the promise.

## 4. Run the tests

Run the new test file in isolation first (fast feedback). Then run the full test suite to catch regressions. If the suite fails for reasons unrelated to your change, mention it but do not "fix" it without asking.

## 5. Coverage

Aim for the cases in the test plan to be covered, not for an arbitrary percentage. A function with 95 % line coverage and 0 % branch coverage is a smell — use `if` branches in the tests, not just `if` in the production code.

## Anti-patterns to avoid

- **Snapshot everything**: snapshots that nobody reads are dead weight. Use them only for genuinely stable output (serialised data, error pages).
- **Test the implementation, not the behaviour**: `expect(mockDependency).toHaveBeenCalledWith(x)` is fine; `expect(spyOnPrivateMethod).toHaveBeenCalled` is a smell.
- **One mega-test**: a 200-line test that exercises every branch is unmaintainable. Split it.
- **Tests that depend on the network or the filesystem**: mock everything; the test suite must be hermetic.
