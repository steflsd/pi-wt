# @steflsd/pi-wt

A Pi extension for creating and switching git workspaces from inside Pi.

## Goal

Open Pi once, usually from your main checkout, then use `/wt` to either:

- jump to an existing active worktree, or
- create a fresh worktree for a new task and switch into a Pi session there

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

- the **current checkout**
- the **main checkout**
- any **existing linked worktrees**
- **Create new worktree…**

If you choose **Create new worktree…**, `pi-wt` asks for:

1. **base branch**
2. **new branch name**
3. optional **path override**
4. confirmation

Then it runs the equivalent of:

```bash
git worktree add -b <new-branch> <path> <base-branch>
```

and switches into the most recent Pi session for that new workspace, or creates one if none exists.

## Default worktree path

By default, new worktrees are created under:

```text
../worktrees/<sanitized-branch>
```

relative to the repo's main checkout.

## Session behavior

By default:

- `/wt` continues the most recent session in the selected workspace
- if no session exists yet, `/wt` creates one

Optional modes:

- `/wt pick` — choose from existing sessions in that workspace
- `/wt new` — force creation of a fresh session in that workspace

## Configuration

This extension registers a CLI flag:

- `--wt-root`

Examples:

```bash
pi -e /Users/steflsd/src/steflsd/pi-wt --wt-root ../worktrees
pi -e /Users/steflsd/src/steflsd/pi-wt --wt-root /Users/steflsd/src/worktrees
```

Relative paths are resolved from the repo's main checkout.

## Notes

- Uses raw `git worktree` commands
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
