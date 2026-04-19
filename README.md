# @steflsd/pi-wt

A Pi extension for worktree-aware git workflows inside Pi.

## Goal

Open Pi once, usually from your main checkout, then use `/wt` to:

- jump to an existing worktree under your configured worktree root,
- create a fresh worktree for a new task and either switch into it here or open it in a terminal,
- inspect the current branch / detected base branch with `/wt status`,
- update the current branch by rebasing onto its detected base branch with `/wt rebase` (clean working tree required),
- open the current worktree in your editor or terminal with `/wt editor` and `/wt term`, or
- view/create a PR with `/wt pr`

## Design

`pi-wt` treats:

- a **checkout/worktree** as execution context
- a **Pi session** as conversation context

So `/wt` does:

1. choose or create a workspace
2. choose a Pi session for that workspace, or create one if none exists

## Workflow

Run:

```text
/wt
```

You will see:

- **Create new worktree…**
- any **existing linked worktrees** under the configured worktree root, including the current one when you're already in a linked worktree

From that list, press **`a`** to archive the currently highlighted linked worktree. If it's the current worktree, `pi-wt` switches away first and checks out its recorded base branch before archiving.

If you choose **Create new worktree…**, `pi-wt` asks for:

1. **base branch**
   - the list shows the most recent local branches first
   - if the branch you want is older, choose **Other branch…** and type its name
2. if the current worktree is dirty **and** the selected base branch is the current branch, choose whether to:
   - create a clean worktree, or
   - move the current worktree's local changes into the new worktree (tracked + untracked)
3. **new branch name**
4. confirmation
5. **open here** or **open in terminal**

Then it runs the equivalent of:

```bash
git worktree add -b <new-branch> <path> <base-branch>
```

After creation, `pi-wt` also stores the chosen base branch in git config:

```bash
git config branch.<new-branch>.wt-parent <base-branch>
```

If you choose to move local changes, `pi-wt` stashes the current worktree's tracked + untracked changes, applies them in the new worktree, and removes the stash entry only after a successful apply.

If the repo contains a shared setup script at:

```text
.pi/wt/setup.sh
```

`pi-wt` runs it inside the new worktree before switching sessions.

A typical example is:

```bash
#!/usr/bin/env bash
set -euo pipefail
pnpm install
```

After creation, `pi-wt` opens the new worktree in a new terminal tab, starts `pi` there, and leaves the current Pi session alone.

## Default worktree path

By default, new worktrees are created under:

```text
../worktrees/<repo-name>/<sanitized-branch>
```

relative to the repo's main checkout.

## Commands

### Worktree/session commands

By default:

- `/wt` lets you choose from existing sessions in the selected workspace
- if no session exists yet, `/wt` creates one
- when creating a new worktree, `/wt` opens it in a new terminal tab and starts `pi`

### Branch/PR commands

- `/wt status` — show repo root, current worktree, current branch, and default branch; on non-default branches it also shows the detected base branch and current PR (if any)
- `/wt rebase` — rebase the current branch onto the detected base branch (clean working tree required)
  - Pi only shows the startup `/wt rebase ... blocked` status for linked worktrees created from a recorded base branch (`branch.<name>.wt-parent`), not for the repo's main checkout
- `/wt rebase <branch>` — rebase onto an explicit branch instead
- `/wt pr` — show the current branch's PR, or create one if none exists yet; if the branch is unpublished or ahead of its upstream, `/wt pr` pushes it first as needed and drafts the PR title/body with the active model
- `/wt pr <branch>` — create the PR against an explicit base branch instead
- `/wt editor` — open the current worktree in your configured editor
- `/wt term` — open the current worktree in your configured terminal

Base-branch detection order for `/wt rebase` and `/wt pr`:

1. current PR base branch via `gh pr view`
2. configured base branch via `git config branch.<name>.wt-parent`
3. configured base branch via `git config branch.<name>.gh-merge-base`
4. repo default branch from `origin/HEAD` (only when the current branch is not already the default branch)

## Configuration

This extension uses pi's standard project-local `.pi/` directory.

Shared project setup:

- `.pi/wt/setup.sh` — optional repo-local setup script run inside newly created worktrees
- `.pi/wt/pr.md` — optional repo-local prompt override for `/wt pr` title/body drafting
- `.pi/settings.json` — optional project-local worktree templates and open commands

If `.pi/wt/pr.md` is missing, `pi-wt` uses its bundled default prompt.

Example `.pi/settings.json`:

```json
{
  "wt": {
    "templates": [
      { "name": "feature", "prefix": "feature/", "base": "main" },
      { "name": "fix", "prefix": "fix/", "base": "main" },
      { "name": "spike", "prefix": "spike/" }
    ],
    "branchPickerLimit": 12,
    "editorCommand": "cursor {{path}}",
    "terminalCommand": "open -a Terminal {{path}}",
    "newWorktreeTabCommand": "wezterm start --cwd {{path}} pi"
  }
}
```

When templates are present, `/wt` shows a lightweight template list before the normal base-branch / branch-name prompts.

`wt.branchPickerLimit` controls how many recent local branches are shown before falling back to **Other branch…**. If unset, the default is `12`.

For `/wt editor` and `/wt term`, `{{path}}` is replaced with the current worktree path. If the command does not include `{{path}}`, `pi-wt` appends the current worktree path automatically.

For opening a newly created worktree in a new tab, `wt.newWorktreeTabCommand` can use `{{path}}` and optionally `{{command}}` (which defaults to `pi`). If `{{command}}` is omitted, `pi-wt` appends `pi` automatically.

`/wt term` also checks `TERM_PROGRAM` on macOS when `wt.terminalCommand` is not configured, so it can reuse the current terminal app for common terminals like Terminal, iTerm, Ghostty, WezTerm, and Warp.

CLI flags:

- `--wt-root` — base directory for newly created worktrees; actual paths are `<wt-root>/<repo-name>/<branch-name>`
- `--wt-setup` — optional fallback shell command to run when `.pi/wt/setup.sh` is not present

Examples:

```bash
pi -e /Users/steflsd/src/steflsd/pi-wt --wt-root ../worktrees
pi -e /Users/steflsd/src/steflsd/pi-wt --wt-root /Users/steflsd/src/worktrees
pi -e /Users/steflsd/src/steflsd/pi-wt --wt-setup "pnpm install"
```

Relative `--wt-root` values are resolved from the repo's main checkout.

## Notes

- Uses raw `git worktree`, `git rebase`, `git branch -d`, and `gh pr` commands
- `/wt editor` and `/wt term` use configured commands from `.pi/settings.json` when present
- Newly created worktrees can be opened in a new tab and start `pi`; configure `wt.newWorktreeTabCommand` to override the default launcher
- Without config, `pi-wt` falls back to `$VISUAL`/`$EDITOR` for `/wt editor` and best-effort platform defaults for `/wt term`
- On macOS, `/wt term` prefers the current `TERM_PROGRAM` when recognized before falling back to Terminal.app
- Only shows existing worktrees under the configured worktree root
- By default, `/wt` lets you choose a session in the selected workspace
- Creating a new worktree opens it in a new tab and starts `pi`, leaving the current Pi session alone
- `.pi/wt/setup.sh` takes precedence over `--wt-setup`
- `/wt pr` requires the GitHub CLI (`gh`)
- `/wt pr` will push the current branch first when needed so `gh pr create` can run non-interactively
- `/wt pr` uses the active model to draft the PR title/body from `.pi/wt/pr.md` when available, and falls back to `gh pr create --fill` if drafting fails or no model is selected
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
