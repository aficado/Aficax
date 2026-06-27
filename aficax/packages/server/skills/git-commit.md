---
name: git-commit
description: Write clear, conventional commit messages and stage changes sensibly.
tools: [read_file, bash, grep]
triggers:
  - "git commit"
  - "commit changes"
  - "commit message"
  - "conventional commit"
always: false
---

# Git Commit

When the user asks you to commit changes, follow this procedure.

## 1. Inspect the current state

- Run `git status --porcelain` to see staged and unstaged files.
- Run `git diff --staged` to see what is about to be committed. If nothing is staged, also check `git diff` for unstaged work.
- Run `git log -n 5 --oneline` to see recent commit style (so you match the project convention).

## 2. Stage intentionally

- Never run `git add .` blindly. Stage specific files (`git add <path>`) when the diff mixes concerns.
- If a file contains unrelated changes, ask the user whether to split it into a separate commit.
- Avoid committing generated artefacts (`dist/`, `build/`, `node_modules/`, lockfile churn) unless the user asks.

## 3. Write the message

Follow the project's preferred convention. Most projects use Conventional Commits; if `git log` shows a different style, mirror it.

**Conventional Commits template:**

```
<type>(<scope>)<!>: <subject>

<body — explain WHY, not WHAT (the diff shows what)>

<footer — references, breaking-change notes>
```

Valid types: `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `style`, `revert`. Append `!` and add a `BREAKING CHANGE:` footer for breaking changes.

**Subject line rules:**
- Imperative mood ("add", not "added"). 
- 50 characters max; 72 is the absolute cap.
- No trailing period.
- Lowercase.

**Body rules:**
- Wrap at 72 columns.
- One blank line between subject and body.
- Use bullet points (`- `) for multiple points.

## 4. Run the commit

Prefer the multi-line form so quoting is not a problem:

```bash
git commit -F - <<'EOF'
<subject>

<body>
EOF
```

Always pass `--` to scripts you run so the user can audit them. If a pre-commit hook fails, read its output carefully and decide whether to amend, fix, or abort — never skip hooks without asking.

## 5. Verify

Run `git log -n 1 --stat` to confirm the commit landed with the intended files.
