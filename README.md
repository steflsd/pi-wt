# @steflsd/pi-wt

A Pi extension for worktree-aware git workflows inside Pi.

## Goal

Open Pi once, usually from your main checkout, then use `/wt` to:

- jump to an existing worktree under your configured worktree root,
- create a fresh worktree for a new task and switch into a Pi session there,
- inspect the current branch / detected base branch with `/wt status`,
- update the current branch by rebasing onto its detected base branch with `/wt rebase` (clean working tree required), or
- view/create a PR with `/wt pr`

## Design

`pi-wt` treats:

- a **checkout/worktree** as execution context
- a **Pi session** as conversation context

So `/wt` does:

1. pick or create a workspace
2. continue the most recent Pi session for that workspace, or create one if none exists

## Workflow

Run:

```text
/wt
```

You will see:

- **Create new worktree…**
- any **existing linked worktrees** under the configured worktree root

If you choose **Create new worktree…**, `pi-wt` asks for:

1. **base branch**
2. **new branch name**
3. confirmation

Then it runs the equivalent of:

```bash
git worktree add -b <new-branch> <path> <base-branch>
```

After creation, `pi-wt` also stores the chosen base branch in git config:

```bash
git config branch.<new-branch>.wt-parent <base-branch>
```

If the repo contains a shared setup script at:

```text
.pi/wt-setup.sh
```

`pi-wt` runs it inside the new worktree before switching sessions.

A typical example is:

```bash
#!/usr/bin/env bash
set -euo pipefail
pnpm install
```

After that, it switches into the most recent Pi session for that workspace, or creates one if none exists.

## Default worktree path

By default, new worktrees are created under:

```text
../worktrees/<sanitized-branch>
```

relative to the repo's main checkout.

## Commands

### Worktree/session commands

By default:

- `/wt` continues the most recent session in the selected workspace
- if no session exists yet, `/wt` creates one

Optional modes:

- `/wt pick` — choose from existing sessions in that workspace
- `/wt new` — force creation of a fresh session in that workspace

### Branch/PR commands

- `/wt status` — show repo root, current worktree, current branch, default branch, detected base branch, and current PR (if any)
- `/wt rebase` — rebase the current branch onto the detected base branch (clean working tree required)
- `/wt rebase <branch>` — rebase onto an explicit branch instead
- `/wt pr` — show the current branch's PR, or create one if none exists yet
- `/wt pr <branch>` — create the PR against an explicit base branch instead

Base-branch detection order for `/wt rebase` and `/wt pr`:

1. current PR base branch via `gh pr view`
2. configured base branch via `git config branch.<name>.wt-parent`
3. configured base branch via `git config branch.<name>.gh-merge-base`
4. repo default branch from `origin/HEAD`

## Configuration

This extension uses pi's standard project-local `.pi/` directory.

Shared project setup:

- `.pi/wt-setup.sh` — optional repo-local setup script run inside newly created worktrees
- `.pi/settings.json` — optional project-local worktree templates

Minimal template example:

```json
{
  "wt": {
    "templates": [
      { "name": "feature", "prefix": "feature/", "base": "main" },
      { "name": "fix", "prefix": "fix/", "base": "main" },
      { "name": "spike", "prefix": "spike/" }
    ]
  }
}
```

When templates are present, `/wt` shows a lightweight template picker before the normal base-branch / branch-name prompts.

CLI flags:

- `--wt-root` — root directory for newly created worktrees
- `--wt-setup` — optional fallback shell command to run when `.pi/wt-setup.sh` is not present

Examples:

```bash
pi -e /Users/steflsd/src/steflsd/pi-wt --wt-root ../worktrees
pi -e /Users/steflsd/src/steflsd/pi-wt --wt-root /Users/steflsd/src/worktrees
pi -e /Users/steflsd/src/steflsd/pi-wt --wt-setup "pnpm install"
```

Relative `--wt-root` values are resolved from the repo's main checkout.

## Notes

- Uses raw `git worktree`, `git rebase`, and `gh pr` commands
- Only shows existing worktrees under the configured worktree root
- By default, `/wt` resumes the most recent session in the selected workspace
- Use `/wt pick` to choose a session explicitly
- Use `/wt new` to force a fresh session
- `.pi/wt-setup.sh` takes precedence over `--wt-setup`
- `/wt pr` requires the GitHub CLI (`gh`)
- No `tmux`
- No `worktrunk` dependency in v1

## Local usage

```bash
pi -e /Users/steflsd/src/steflsd/pi-wt
```

Or install as a local package:

```bash
pi install /Users/steflsd/src/steflsd/pi-wt
```

Or install from GitHub:

```bash
pi install git:github.com/steflsd/pi-wt
```

Then run `/reload` in Pi.
