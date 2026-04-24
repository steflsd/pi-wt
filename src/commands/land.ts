import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { commitAllChangesWithDraft } from "../commits.js";
import { exec, inspectRepo, refreshWorktreeStateStatus, summarizeCommandOutput } from "../git.js";
import {
	evaluateLandingReadiness,
	formatLandingReadinessMessage,
	inspectLandingFacts,
	isReadyLandingFacts,
	type ReadyLandingFacts,
} from "../landing.js";
import { cancelIfAborted } from "../shared.js";
import type { RepoState } from "../types.js";
import { archiveWorktreeAtPathFlow, getConfiguredWorktreeRoot, readProjectWorktreeSettings } from "../worktrees.js";

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
	const facts = await ensureLandingReady(pi, ctx, repo, worktreePath);
	if (!facts) {
		return;
	}

	const confirmationLines = [
		`Feature branch: ${facts.featureBranch}`,
		`Base branch: ${facts.baseBranch.name}`,
		`Base ref: ${facts.baseBranch.ref}`,
		`Base source: ${facts.baseBranch.source}`,
		`Feature worktree: ${facts.featureWorktree.path}`,
		`Destination checkout: ${facts.destination.workspace.cwd}`,
		"Action: rebase feature branch onto base, then fast-forward merge base",
	];
	if (facts.destination.requiresCheckout) {
		confirmationLines.push(`Checkout destination branch: ${facts.baseBranch.name}`);
	}
	const confirmed = await ctx.ui.confirm("Land branch", confirmationLines.join("\n"));
	if (!confirmed) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	await ctx.waitForIdle();
	if (cancelIfAborted(ctx)) {
		return;
	}

	let replacedSession = false;
	try {
		ctx.ui.setStatus("pi-wt", `Rebasing ${facts.featureBranch} onto ${facts.baseBranch.ref}...`);
		const rebased = await exec(pi, "git", ["rebase", facts.baseBranch.ref], facts.featureWorktree.path, {
			signal: ctx.signal,
		});
		if (cancelIfAborted(ctx)) {
			return;
		}
		if (rebased.code !== 0) {
			ctx.ui.notify(
				[
					`git rebase ${facts.baseBranch.ref} failed.`,
					summarizeCommandOutput(rebased) ||
						"Resolve conflicts, then run git rebase --continue or git rebase --abort manually.",
				].join("\n\n"),
				"error",
			);
			return;
		}

		if (facts.destination.requiresCheckout) {
			ctx.ui.setStatus("pi-wt", `Checking out ${facts.baseBranch.name}...`);
			const checkedOut = await exec(
				pi,
				"git",
				["checkout", facts.baseBranch.name],
				facts.destination.workspace.cwd,
				{
					signal: ctx.signal,
				},
			);
			if (cancelIfAborted(ctx)) {
				return;
			}
			if (checkedOut.code !== 0) {
				ctx.ui.notify(
					[
						`Failed to check out ${facts.baseBranch.name} in ${facts.destination.workspace.cwd}.`,
						summarizeCommandOutput(checkedOut) || `git checkout ${facts.baseBranch.name} failed`,
					].join("\n\n"),
					"error",
				);
				return;
			}
		}

		ctx.ui.setStatus("pi-wt", `Merging ${facts.featureBranch} into ${facts.baseBranch.name}...`);
		const merged = await exec(
			pi,
			"git",
			["merge", "--ff-only", facts.featureBranch],
			facts.destination.workspace.cwd,
			{ signal: ctx.signal },
		);
		if (cancelIfAborted(ctx)) {
			return;
		}
		if (merged.code !== 0) {
			ctx.ui.notify(
				[
					`git merge --ff-only ${facts.featureBranch} failed.`,
					summarizeCommandOutput(merged) || "The base branch was not updated.",
				].join("\n\n"),
				"error",
			);
			return;
		}

		const settings = readProjectWorktreeSettings(repo);
		if (!facts.featureWorktree.isMainCheckout && settings.archiveAfterLand) {
			const refreshedRepo = await inspectRepo(pi, facts.destination.workspace.cwd);
			if (!refreshedRepo) {
				ctx.ui.notify(`Landed ${facts.featureBranch} into ${facts.baseBranch.name}.`, "info");
				return;
			}

			ctx.ui.setStatus("pi-wt", `Archiving ${facts.featureBranch}...`);
			const archiveResult = await archiveWorktreeAtPathFlow(
				pi,
				ctx,
				refreshedRepo,
				getConfiguredWorktreeRoot(pi),
				facts.featureWorktree.path,
				{ skipConfirmation: true, skipSuccessNotification: !facts.featureWorktree.isCurrent },
			);
			replacedSession = archiveResult.replacedSession;
			if (replacedSession) {
				return;
			}
			ctx.ui.notify(
				archiveResult.archived
					? `Landed ${facts.featureBranch} into ${facts.baseBranch.name} and archived the worktree.`
					: `Landed ${facts.featureBranch} into ${facts.baseBranch.name}.`,
				archiveResult.archived ? "info" : "warning",
			);
			return;
		}

		ctx.ui.notify(`Landed ${facts.featureBranch} into ${facts.baseBranch.name}.`, "info");
	} finally {
		if (!replacedSession) {
			ctx.ui.setStatus("pi-wt", undefined);
			await refreshWorktreeStateStatus(pi, ctx);
		}
	}
}

async function ensureLandingReady(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repo: RepoState,
	worktreePath: string,
): Promise<ReadyLandingFacts | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		if (cancelIfAborted(ctx)) {
			return null;
		}

		const facts = await inspectLandingFacts(pi, repo, worktreePath, {
			includePullRequest: true,
			includeMergeState: true,
			featureChanges: "all",
			destinationChanges: "all",
		});
		const readiness = evaluateLandingReadiness(facts);
		if (readiness.kind === "ready") {
			if (!isReadyLandingFacts(facts)) {
				ctx.ui.notify("Could not determine the landing state.", "error");
				return null;
			}
			return facts;
		}
		if (
			readiness.kind === "feature-has-local-changes" &&
			attempt === 0 &&
			facts.featureWorktree &&
			facts.featureBranch &&
			facts.baseBranch
		) {
			const shouldCommit = await ctx.ui.confirm(
				"Commit and land",
				`${facts.featureBranch} has local changes. Landing requires a commit first.`,
			);
			if (!shouldCommit) {
				ctx.ui.notify("Cancelled", "info");
				return null;
			}

			const committed = await commitAllChangesWithDraft(
				pi,
				ctx,
				repo,
				facts.featureWorktree.path,
				facts.featureBranch,
				facts.baseBranch,
				{
					actionLabel: "Committing changes",
					promptTitle: `Commit message · ${facts.featureBranch}`,
				},
			);
			if (cancelIfAborted(ctx)) {
				return null;
			}
			if (!committed) {
				return null;
			}
			continue;
		}

		const readinessMessage = formatLandingReadinessMessage(facts, readiness);
		if (readinessMessage) {
			ctx.ui.notify(readinessMessage.message, readinessMessage.level);
		}
		return null;
	}

	return null;
}
