# `/wt land` design note

Status: draft / not implemented

## Summary

Add a local-only landing flow to `pi-wt` for merging a feature branch into its base branch without creating a PR.

This feature should support two entry points:

- from the current feature worktree via `/wt land`
- from the `/wt` picker via an `l` action on the highlighted worktree

The core behavior is:

1. detect the feature branch and its base branch
2. if the feature worktree has uncommitted changes, offer to commit them first
3. rebase the feature branch onto its base branch
4. switch to the base branch checkout
5. fast-forward merge the feature branch into the base branch
6. optionally archive the landed worktree

## Goals

- support a no-PR local landing flow
- preserve a linear history
- work both from the current feature worktree and from the main/base checkout via the picker
- handle dirty feature worktrees with a guided commit flow
- keep users in control of commit messages and destructive actions
- fail clearly and stop at the first unsafe or ambiguous step

## Non-goals

- auto-resolve merge or rebase conflicts
- silently stash and replay changes as the primary landing model
- rewrite the base branch in a surprising way
- support non-fast-forward landing
- replace normal Git commit workflows for all users

## Why this exists

Today, `pi-wt` supports:

- creating and switching worktrees
- rebasing a feature branch onto its detected base branch
- PR creation
- archiving landed worktrees

What it does not support yet is the common local flow:

1. finish work on a feature branch
2. rebase that branch onto `main` (or another base)
3. fast-forward `main` to the feature branch
4. archive the feature worktree

This document describes a future feature to cover that gap.

## Recommended Git model

The intended history model is:

1. commit current work on the feature branch if needed
2. rebase the feature branch onto its base branch
3. switch to the base branch checkout
4. run `git merge --ff-only <feature-branch>`

This keeps the history linear without rewriting the base branch directly.

## Key design decision: commit first, not stash-first

The preferred model is:

- if the feature worktree is dirty, commit first
- then rebase
- then fast-forward merge

Avoid making this primarily:

- stash
- rebase
- pop
- commit

Reason:

- stash/pop after a rebase is harder to reason about
- failure states are more confusing
- auto-committing after replaying a stash makes the resulting history less obvious

Stash may still be useful internally as a recovery mechanism, but it should not be the main user-facing mental model.

## User-facing API

### Command

Add:

- `/wt land`

Possible future extension:

- `/wt land <branch>`

For the first version, `/wt land` is enough.

### Picker action

In the `/wt` picker, add:

- `l` = land highlighted worktree

This should work whether the user is currently in that worktree or sitting in another checkout such as `main`.

## Supported flows

### Flow A: current feature worktree

User is in a linked feature worktree.

They run:

```text
/wt land
```

Expected behavior:

1. detect current branch
2. detect base branch
3. if dirty, offer commit flow
4. rebase current branch onto base
5. switch to a checkout for the base branch
6. fast-forward merge feature branch into base
7. optionally archive

### Flow B: from main/base checkout

User is in the main checkout or another worktree.

They run:

```text
/wt
```

Then highlight a feature worktree and press:

```text
l
```

Expected behavior:

1. inspect the highlighted worktree
2. detect feature branch and base branch
3. if dirty, offer commit flow in that worktree
4. rebase that feature branch onto base
5. switch to a checkout for the base branch
6. fast-forward merge feature branch into base
7. optionally archive

## Preconditions

Landing should require:

- selected/current branch is not detached HEAD
- selected/current branch is not already the base branch
- a base branch can be detected or explicitly determined
- the base branch checkout exists or can be selected safely
- the destination base checkout is clean before final merge
- the final merge can be done with `--ff-only`

## Dirty worktree behavior

If the feature worktree has local uncommitted changes, do not silently stash and continue.

Instead prompt the user with something like:

- **Commit and land**
- **Cancel**

If the user chooses **Commit and land**:

1. stage changes
2. draft a commit message
3. allow confirmation or editing
4. create the commit
5. continue with rebase and landing

## Commit drafting

### Proposed prompt file

Use a repo-local optional prompt similar to PR drafting:

```text
.pi/wt/commit.md
```

If missing, use a bundled default prompt.

### Drafting behavior

The commit message generator should:

- inspect staged or working-tree changes
- generate a commit title and optional body
- let the user edit or confirm before commit

Do not silently auto-commit with an unreviewed generated message.

### Suggested output shape

Similar to PR drafting, but commit-focused. Possible structured output:

```text
<title>short subject line</title>
<body>optional body</body>
```

Or simply return a subject/body pair in a simpler format if commit drafting is implemented independently.

## Base branch resolution

Use the same detection order as `/wt rebase` and `/wt pr`:

1. current PR base branch via `gh pr view`
2. `branch.<name>.wt-parent`
3. `branch.<name>.gh-merge-base`
4. repo default branch from `origin/HEAD` when current branch is not already the default branch

## Base checkout selection

To fast-forward merge into the base branch, the extension needs a safe checkout for that base branch.

Preferred order:

1. an existing worktree currently on the base branch
2. the main checkout, if available and safe

If the chosen destination checkout has local changes, block landing and tell the user to clean that checkout first.

## Proposed flow in detail

### 1. Inspect target

Identify:

- feature branch
- feature worktree path
- base branch
- destination checkout for base branch
- current dirty state of feature worktree
- dirty state of destination base checkout

### 2. Validate

Block if:

- detached HEAD
- no base branch can be determined
- feature branch equals base branch
- destination base checkout is dirty
- user cancels

### 3. Optional commit step

If feature worktree is dirty:

- prompt to commit and land or cancel
- draft commit message
- allow edit/confirm
- run `git add -A`
- run `git commit`

### 4. Rebase step

Run in the feature worktree:

```bash
git rebase <base-ref>
```

If this fails:

- stop immediately
- show the rebase output
- explain that the user must resolve conflicts and continue or abort manually
- do not continue into merge or archive

### 5. Switch to base checkout

Switch session/checkouts as needed so merge happens in the destination base checkout.

If the destination is not already on the base branch, check it out.

### 6. Fast-forward merge

Run in the base checkout:

```bash
git merge --ff-only <feature-branch>
```

If this fails:

- stop immediately
- show the error output
- do not archive automatically

### 7. Post-land behavior

After a successful fast-forward merge:

- notify the user that the feature branch has been landed into the base branch
- optionally offer to archive the landed worktree
- optionally delete the local feature branch if archive logic determines it is safe

## Archive behavior

After a successful land, recommended default UX:

- prompt: **Archive landed worktree?**
  - **Archive**
  - **Keep**

Possible future config:

```json
{
  "wt": {
    "archiveAfterLand": true
  }
}
```

Default can be discussed later. A prompt-based first version is safer.

## Suggested prompts and copy

### Dirty feature worktree

Title:

```text
Commit and land
```

Body:

```text
<feature-branch> has local changes. Landing requires a commit first.
```

Options:

- Commit and land
- Cancel

### Confirm land

Title:

```text
Land branch
```

Body:

```text
Feature branch: <feature-branch>
Base branch: <base-branch>
Feature worktree: <path>
Destination checkout: <path>
Action: rebase feature branch onto base, then fast-forward merge base
```

### Successful land

```text
Landed <feature-branch> into <base-branch>.
```

### Rebase failure

```text
git rebase <base-ref> failed.
Resolve conflicts, then run git rebase --continue or git rebase --abort manually.
```

### Fast-forward merge failure

```text
git merge --ff-only <feature-branch> failed.
The base branch was not updated.
```

## Suggested implementation shape

Likely additions:

- `src/commands/land.ts`
- shared helpers in `src/git.ts` and/or `src/worktrees.ts`
- optional commit drafting helper near `src/pull-requests.ts`
- update picker UI in `src/worktrees.ts` to support `l`
- parser updates in `src/command-spec.ts`

Possible helper responsibilities:

- detect landing target and destination checkout
- read dirty state for feature and base checkout
- generate commit message draft
- commit working tree changes
- perform rebase with clear error propagation
- perform ff-only merge with clear error propagation
- archive after success

## Possible config keys

Not required for v1, but worth considering:

```json
{
  "wt": {
    "archiveAfterLand": true,
    "confirmBeforeLand": true,
    "allowCommitDraftForLand": true
  }
}
```

Possible meanings:

- `archiveAfterLand`: archive automatically after successful land, or default the prompt to archive
- `confirmBeforeLand`: require an explicit confirmation before starting
- `allowCommitDraftForLand`: enable the commit drafting flow

## Failure handling rules

Landing should stop at the first failure.

Do not continue automatically after:

- commit failure
- rebase failure
- checkout failure
- merge failure

In all failure cases:

- keep the current state explicit
- show the relevant Git output
- avoid cleanup that hides what happened

## Open questions

- should `/wt land` support an explicit branch argument in the first version?
- should post-land archive default to yes, no, or always prompt?
- should commit drafting be required, optional, or deferred to a later version?
- should the commit step use `git add -A` or offer staged-only behavior?
- should landing from the picker auto-switch the active Pi session to the feature worktree before commit/rebase operations, or keep session switching minimal?

## Recommended first version

A good first implementation would be:

- `/wt land`
- `l` action in picker
- require a detectable base branch
- block on dirty feature worktree unless user chooses **Commit and land**
- commit via generated draft + confirmation/edit
- rebase onto base
- merge `--ff-only` into base
- prompt to archive afterward

That version gives a complete local landing flow without trying to be too magical.
