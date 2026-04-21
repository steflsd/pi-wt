# @steflsd/pi-wt

A Pi extension for worktree-aware Git workflows.

Use `/wt` to:

- switch to an existing linked worktree,
- create a new worktree and start `pi` there,
- inspect branch and base-branch status,
- land a feature branch into its detected base branch,
- rebase onto the detected base branch,
- open the current worktree in your editor or terminal, and
- view or create a PR.

## Quick Start

Install from GitHub:

```bash
pi install git:github.com/steflsd/pi-wt
```

Install from a local checkout:

```bash
pi install /path/to/pi-wt
```

Or try it without installing:

```bash
pi -e /path/to/pi-wt
```

Then start `pi` inside a Git repo and run:

```text
/wt
```

If you install the extension into an already-running Pi session, run `/reload`.

## Safety Recommendation

Pi extensions run with your user permissions and can execute local commands.

If you cloned this repo, or any repo containing a Pi extension package, it is worth asking your LLM to review the extension code before installing it. Ask it to look for anything obscured, dangerous, or malicious in:

- the extension source,
- shell commands it runs,
- setup scripts it invokes,
- install or publish scripts, and
- any surprising behavior around credentials, file access, or process launching.

That review should be about the extension package and how it is used, not a security review of the project you plan to use it with.

## Requirements

- [Pi](https://github.com/badlogic/pi-mono) installed
- a Git repository
- `git worktree` available
- `gh` installed if you want `/wt pr`

Interactive UI mode is required for:

- `/wt`
- `/wt land`
- `/wt rebase`
- `/wt pr`

These commands also work in non-UI/headless contexts:

- `/wt status`
- `/wt editor` and `/wt edit`
- `/wt terminal` and `/wt term`
- `/wt help`

## How It Works

`pi-wt` treats:

- a **worktree** as execution context, and
- a **Pi session** as conversation context.

So `/wt` does two things:

1. choose or create a workspace
2. choose a Pi session for that workspace, or create one if none exists

## Daily Usage

Run:

```text
/wt
```

You will see:

- **Create new worktree…**
- existing linked worktrees under the configured worktree root

Press **`a`** in the picker to archive the highlighted linked worktree. If it is the current worktree, `pi-wt` switches away first and checks out its recorded base branch before archiving.

Press **`l`** in the picker to land the highlighted linked worktree: commit dirty changes first, rebase onto its detected base branch, fast-forward merge into the base checkout, and auto-archive by default.

### Creating a worktree

When you choose **Create new worktree…**, `pi-wt` asks for:

1. a **base branch**
   - recent local branches are shown first
   - choose **Other branch…** to type an older branch name
2. whether to create a clean worktree or move current local changes, when the selected base branch is the current branch and the current worktree is dirty
3. a **new branch name**
4. confirmation

Then it opens the new worktree in a new terminal tab and starts `pi`.

Equivalent Git command:

```bash
git worktree add -b <new-branch> <path> <base-branch>
```

It also records the chosen base branch in Git config:

```bash
git config branch.<new-branch>.wt-parent <base-branch>
```

If you choose to move local changes, `pi-wt` stashes tracked and untracked changes, applies them in the new worktree, and only removes the stash entry after successful worktree creation end-to-end.

If a later step fails after `git worktree add` (for example applying moved changes or running setup), `pi-wt` best-effort rolls back the new worktree and branch and restores the original stash to the source worktree.

If the repo's main checkout contains a shared setup script at:

```text
.pi/wt/setup.sh
```

`pi-wt` runs that script with the new worktree as its working directory before switching sessions.

A typical example is:

```bash
#!/usr/bin/env bash
set -euo pipefail
pnpm install
```

### Session behavior for new worktrees

After creation:

- from the main/default branch with existing session history: continue that Pi session in the new terminal
- otherwise: start a fresh Pi session in the new worktree terminal

## Commands

### Workspace and session commands

- `/wt` — open the worktree picker, then choose or create a session for that workspace
- `/wt editor` — open the current worktree root in your configured editor
- `/wt edit` — alias for `/wt editor`
- `/wt terminal` — open the current worktree root in your configured terminal
- `/wt term` — alias for `/wt terminal`
- `/wt help` — show usage

### Branch and PR commands

- `/wt status` — show repo root, current worktree, current branch, default branch, detected base branch, and PR info when relevant
- `/wt land` — land the current branch into its detected base branch; dirty worktrees are committed first, then rebased, fast-forward merged, and auto-archived by default
- `/wt rebase` — rebase the current branch onto its detected base branch
- `/wt rebase <branch>` — rebase onto an explicit base branch instead
- `/wt pr` — show the current branch's PR, create one if none exists yet, or update the existing PR by committing and pushing local changes first when needed
- `/wt pr <branch>` — create the PR against an explicit base branch instead

Notes:

- `/wt land` uses the same base-branch detection as `/wt rebase` and `/wt pr`
- `/wt land` can also be triggered from the `/wt` picker with `l`
- `/wt land` commits dirty worktrees first using a drafted/editable commit message from `.pi/wt/commit.md`
- `/wt pr` does the same when the current branch has local changes, then creates or updates the PR by pushing the branch
- `/wt rebase` requires a clean working tree
- `/wt pr` requires `gh`
- if the branch is unpublished or ahead of its upstream, `/wt pr` pushes it first as needed
- Pi only shows the startup `/wt rebase ... blocked` status for linked worktrees created from a recorded base branch (`branch.<name>.wt-parent`), not for the repo's main checkout

### Base-branch detection order

For `/wt land`, `/wt rebase`, and `/wt pr`, base-branch detection is:

1. current PR base branch via `gh pr view`
2. `git config branch.<name>.wt-parent`
3. `git config branch.<name>.gh-merge-base`
4. repo default branch from `origin/HEAD` when the current branch is not already the default branch

## Default Worktree Path

By default, new worktrees are created under:

```text
../worktrees/<repo-name>/<sanitized-branch>
```

relative to the repo's main checkout.

## Configuration

This extension uses Pi's standard project-local `.pi/` directory.

### Shared project files

- `.pi/wt/setup.sh` — optional repo-local setup script read from the repo's main checkout and executed with newly created worktrees as the working directory
- `.pi/wt/pr.md` — optional prompt override for `/wt pr` title/body drafting
- `.pi/wt/commit.md` — optional prompt override for `/wt land` and `/wt pr` commit-message drafting
- `.pi/settings.json` — optional worktree templates, land behavior, and open commands

If `.pi/wt/pr.md` or `.pi/wt/commit.md` is missing, `pi-wt` uses its bundled default prompt.

### Example `.pi/settings.json`

```json
{
  "wt": {
    "templates": [
      { "name": "feature", "prefix": "feature/", "base": "main" },
      { "name": "fix", "prefix": "fix/", "base": "main" },
      { "name": "spike", "prefix": "spike/" }
    ],
    "branchPickerLimit": 12,
    "archiveAfterLand": true,
    "editorCommand": "cursor {{path}}",
    "terminalCommand": "open -a Terminal {{path}}",
    "newWorktreeTabCommand": "wezterm start --cwd {{path}} {{command}}"
  }
}
```

When templates are present, `/wt` shows a template list before the normal base-branch and branch-name prompts.

### Settings reference

`wt.branchPickerLimit`
- how many recent local branches are shown before falling back to **Other branch…**
- default: `12`

`wt.archiveAfterLand`
- whether `/wt land` auto-archives a successfully landed linked worktree
- default: `true`

`wt.editorCommand` and `wt.terminalCommand`
- `{{path}}` is replaced with the current worktree root path
- if `{{path}}` is omitted, `pi-wt` appends the path automatically

`wt.newWorktreeTabCommand`
- used for opening a newly created worktree in a new terminal tab
- supports `{{path}}`
- optionally supports `{{command}}`, which defaults to `pi`
- recommended: include `{{command}}` explicitly so `pi-wt` can pass resume arguments when carrying a session into the new worktree
- if `{{command}}` is omitted, `pi-wt` appends the launch command automatically

Without `wt.terminalCommand`, `/wt terminal` also checks `TERM_PROGRAM` on macOS so it can reuse the current terminal app for common terminals like Terminal, iTerm, Ghostty, WezTerm, and Warp.

## CLI Flags

- `--wt-root` — base directory for newly created worktrees; actual paths are `<wt-root>/<repo-name>/<branch-name>`
- `--wt-setup` — fallback shell command to run when the main checkout does not contain `.pi/wt/setup.sh`

Examples:

```bash
pi -e /path/to/pi-wt --wt-root ../worktrees
pi -e /path/to/pi-wt --wt-root /absolute/path/to/worktrees
pi -e /path/to/pi-wt --wt-setup "pnpm install"
```

Relative `--wt-root` values are resolved from the repo's main checkout.

## Notes

- Uses raw `git worktree`, `git rebase`, `git branch -d`, and `gh pr` commands
- `/wt editor` and `/wt terminal` use configured commands from `.pi/settings.json` when present
- newly created worktrees can be opened in a new tab and start `pi`; configure `wt.newWorktreeTabCommand` to override the default launcher
- without config, `pi-wt` falls back to `$VISUAL`/`$EDITOR` for `/wt editor` and best-effort platform defaults for `/wt terminal`
- on macOS, `/wt terminal` prefers the current `TERM_PROGRAM` when recognized before falling back to Terminal.app
- only shows existing worktrees under the configured worktree root
- creating a new worktree starts `pi` in that worktree; when creating from the main/default branch with existing session history, `/wt` carries the current session across automatically
- the main checkout's `.pi/wt/setup.sh` takes precedence over `--wt-setup`
- `/wt land` uses the active model to draft commit messages from `.pi/wt/commit.md` when available, then lets you edit/confirm before committing
- `/wt land` auto-archives landed linked worktrees by default; set `wt.archiveAfterLand` to `false` to keep them
- `/wt pr` also uses `.pi/wt/commit.md` when it needs to commit local changes before creating or updating a PR
- `/wt pr` will push the current branch first when needed so `gh pr create` can run non-interactively, and pushing new commits updates an existing PR on the same branch
- `/wt pr` uses the active model to draft the PR title/body from `.pi/wt/pr.md` when available, and falls back to `gh pr create --fill` if drafting fails or no model is selected
