import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { commitAllChangesWithDraft } from "../commits.js";
import {
	detectBaseBranch,
	exec,
	inspectRepo,
	normalizeBranchName,
	readWorktreeChanges,
	refreshWorktreeStateStatus,
	summarizeCommandOutput,
} from "../git.js";
import { switchToLatestOrCreateSession } from "../sessions.js";
import { safeRealpath } from "../shared.js";
import type { RepoState, WorkspaceTarget, WorktreeInfo } from "../types.js";
import { archiveWorktreeAtPathFlow, getConfiguredWorktreeRoot, readProjectWorktreeSettings } from "../worktrees.js";

interface LandingDestination {
	workspace: WorkspaceTarget;
	requiresCheckout: boolean;
}

export async function handleLandCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const repo = await inspectRepo(pi, ctx.cwd);
	if (!repo) {
		ctx.ui.notify("/wt must be run inside a git repository", "error");
		return;
	}

	const currentWorktree = repo.worktrees.find((worktree) => worktree.isCurrent);
	const targetPath = currentWorktree?.path ?? repo.cwd;
	await landWorktreeFlow(pi, ctx, repo, targetPath);
}

export async function landWorktreeAtPathFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	worktreePath: string,
): Promise<void> {
	const repo = await inspectRepo(pi, ctx.cwd);
	if (!repo) {
		ctx.ui.notify("/wt must be run inside a git repository", "error");
		return;
	}

	await landWorktreeFlow(pi, ctx, repo, worktreePath);
}

async function landWorktreeFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repo: RepoState,
	worktreePath: string,
): Promise<void> {
	const featureWorktree = resolveFeatureWorktree(repo, worktreePath);
	if (!featureWorktree) {
		ctx.ui.notify(`Could not find a worktree at ${worktreePath}.`, "error");
		return;
	}
	if (!featureWorktree.branch) {
		ctx.ui.notify(`Cannot land ${featureWorktree.path} from detached HEAD.`, "error");
		return;
	}

	const featureBranch = featureWorktree.branch;
	const baseBranch = await detectBaseBranch(pi, repo, featureWorktree.path, featureBranch);
	if (!baseBranch) {
		ctx.ui.notify("Could not determine a base branch. Try /wt status or configure branch.<name>.wt-parent.", "error");
		return;
	}
	if (normalizeBranchName(baseBranch.name) === normalizeBranchName(featureBranch)) {
		ctx.ui.notify(`Refusing to land ${featureBranch} into itself`, "error");
		return;
	}

	const destination = resolveLandingDestination(repo, featureWorktree, baseBranch.name);
	if (!destination) {
		ctx.ui.notify(`Could not find a safe checkout for base branch ${baseBranch.name}.`, "error");
		return;
	}

	const destinationIsFeatureWorktree = safeRealpath(destination.workspace.cwd) === featureWorktree.path;
	const initialFeatureChanges = await readWorktreeChanges(pi, featureWorktree.path, true);
	if (initialFeatureChanges.length > 0) {
		const shouldCommit = await ctx.ui.confirm(
			"Commit and land",
			`${featureBranch} has local changes. Landing requires a commit first.`,
		);
		if (!shouldCommit) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		const committed = await commitAllChangesWithDraft(
			pi,
			ctx,
			repo,
			featureWorktree.path,
			featureBranch,
			baseBranch,
			{
				actionLabel: "Committing changes",
				promptTitle: `Commit message · ${featureBranch}`,
			},
		);
		if (!committed) {
			return;
		}
	}

	const destinationChanges = await readWorktreeChanges(pi, destination.workspace.cwd, true);
	if (destinationChanges.length > 0 && !destinationIsFeatureWorktree) {
		ctx.ui.notify(
			[
				`Cannot land ${featureBranch}: destination checkout ${destination.workspace.cwd} has local changes (${destinationChanges.length}).`,
				"Clean that checkout first.",
				formatChangesPreview(destinationChanges),
			]
				.filter(Boolean)
				.join("\n"),
			"error",
		);
		return;
	}
	if (destinationChanges.length > 0 && destinationIsFeatureWorktree) {
		ctx.ui.notify(
			[
				`Cannot check out ${baseBranch.name} in ${destination.workspace.cwd} because it still has local changes (${destinationChanges.length}).`,
				"Commit, stash, or discard them first.",
				formatChangesPreview(destinationChanges),
			]
				.filter(Boolean)
				.join("\n"),
			"error",
		);
		return;
	}

	const confirmationLines = [
		`Feature branch: ${featureBranch}`,
		`Base branch: ${baseBranch.name}`,
		`Base ref: ${baseBranch.ref}`,
		`Base source: ${baseBranch.source}`,
		`Feature worktree: ${featureWorktree.path}`,
		`Destination checkout: ${destination.workspace.cwd}`,
		`Action: rebase feature branch onto base, then fast-forward merge base`,
	];
	if (destination.requiresCheckout) {
		confirmationLines.push(`Checkout destination branch: ${baseBranch.name}`);
	}
	const confirmed = await ctx.ui.confirm("Land branch", confirmationLines.join("\n"));
	if (!confirmed) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	await ctx.waitForIdle();
	try {
		ctx.ui.setStatus("pi-wt", `Rebasing ${featureBranch} onto ${baseBranch.ref}...`);
		const rebased = await exec(pi, "git", ["rebase", baseBranch.ref], featureWorktree.path);
		if (rebased.code !== 0) {
			ctx.ui.notify(
				[
					`git rebase ${baseBranch.ref} failed.`,
					summarizeCommandOutput(rebased) ||
						"Resolve conflicts, then run git rebase --continue or git rebase --abort manually.",
				].join("\n\n"),
				"error",
			);
			return;
		}

		if (safeRealpath(ctx.cwd) !== safeRealpath(destination.workspace.cwd)) {
			ctx.ui.setStatus("pi-wt", `Switching to ${destination.workspace.cwd}...`);
			const switched = await switchToLatestOrCreateSession(ctx, destination.workspace);
			if (switched.cancelled) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
		}

		if (destination.requiresCheckout) {
			ctx.ui.setStatus("pi-wt", `Checking out ${baseBranch.name}...`);
			const checkedOut = await exec(pi, "git", ["checkout", baseBranch.name], destination.workspace.cwd);
			if (checkedOut.code !== 0) {
				ctx.ui.notify(
					[
						`Failed to check out ${baseBranch.name} in ${destination.workspace.cwd}.`,
						summarizeCommandOutput(checkedOut) || `git checkout ${baseBranch.name} failed`,
					].join("\n\n"),
					"error",
				);
				return;
			}
		}

		ctx.ui.setStatus("pi-wt", `Merging ${featureBranch} into ${baseBranch.name}...`);
		const merged = await exec(pi, "git", ["merge", "--ff-only", featureBranch], destination.workspace.cwd);
		if (merged.code !== 0) {
			ctx.ui.notify(
				[
					`git merge --ff-only ${featureBranch} failed.`,
					summarizeCommandOutput(merged) || "The base branch was not updated.",
				].join("\n\n"),
				"error",
			);
			return;
		}

		const settings = readProjectWorktreeSettings(repo);
		if (!featureWorktree.isMainCheckout && settings.archiveAfterLand) {
			const refreshedRepo = await inspectRepo(pi, destination.workspace.cwd);
			if (!refreshedRepo) {
				ctx.ui.notify(`Landed ${featureBranch} into ${baseBranch.name}.`, "info");
				return;
			}

			ctx.ui.setStatus("pi-wt", `Archiving ${featureBranch}...`);
			const archived = await archiveWorktreeAtPathFlow(
				pi,
				ctx,
				refreshedRepo,
				getConfiguredWorktreeRoot(pi),
				featureWorktree.path,
				{ skipConfirmation: true, skipSuccessNotification: true },
			);
			ctx.ui.notify(
				archived
					? `Landed ${featureBranch} into ${baseBranch.name} and archived the worktree.`
					: `Landed ${featureBranch} into ${baseBranch.name}.`,
				archived ? "info" : "warning",
			);
			return;
		}

		ctx.ui.notify(`Landed ${featureBranch} into ${baseBranch.name}.`, "info");
	} finally {
		ctx.ui.setStatus("pi-wt", undefined);
		await refreshWorktreeStateStatus(pi, ctx);
	}
}

function resolveFeatureWorktree(repo: RepoState, worktreePath: string): WorktreeInfo | undefined {
	const normalizedPath = safeRealpath(worktreePath);
	return repo.worktrees.find((worktree) => worktree.path === normalizedPath);
}

function resolveLandingDestination(
	repo: RepoState,
	featureWorktree: WorktreeInfo,
	baseBranchName: string,
): LandingDestination | null {
	const normalizedBaseBranch = normalizeBranchName(baseBranchName);
	const matchingWorktree = repo.worktrees.find(
		(worktree) =>
			worktree.path !== featureWorktree.path &&
			worktree.branch &&
			normalizeBranchName(worktree.branch) === normalizedBaseBranch,
	);
	if (matchingWorktree) {
		return {
			workspace: {
				cwd: matchingWorktree.path,
				branch: matchingWorktree.branch,
				kind: matchingWorktree.isMainCheckout ? "main" : "worktree",
			},
			requiresCheckout: false,
		};
	}

	const mainCheckout = repo.worktrees.find((worktree) => worktree.isMainCheckout);
	if (!mainCheckout) {
		return null;
	}

	return {
		workspace: {
			cwd: mainCheckout.path,
			branch: mainCheckout.branch,
			kind: "main",
		},
		requiresCheckout: normalizeBranchName(mainCheckout.branch ?? "") !== normalizedBaseBranch,
	};
}

function formatChangesPreview(changes: string[]): string {
	const preview = changes.slice(0, 10).join("\n");
	if (!preview) {
		return "";
	}
	const remainder = changes.length > 10 ? `\n…and ${changes.length - 10} more` : "";
	return `${preview}${remainder}`;
}
