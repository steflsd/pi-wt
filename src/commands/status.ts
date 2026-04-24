import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { inspectCurrentBranchFacts } from "../branch-facts.js";
import { formatPrState, hasGhCli, inspectRepo, normalizeBranchName, readTrackedWorktreeChanges } from "../git.js";
import { evaluateLandingReadiness, inspectLandingFacts } from "../landing.js";
import { reportMessage } from "../shared.js";
import { describeCurrentWorkspace } from "../worktrees.js";

export interface StatusActionHint {
	command: string;
	detail: string;
}

interface BuildStatusActionHintsOptions {
	hasBranch: boolean;
	isDefaultBranch: boolean;
	hasLinkedWorktree: boolean;
	hasBaseBranch: boolean;
	hasPullRequest: boolean;
	ghAvailable: boolean;
	localChangesCount: number;
	trackedChangesCount: number;
	landingReadiness:
		| "missing-feature-worktree"
		| "detached-head"
		| "missing-base-branch"
		| "same-branch"
		| "missing-destination"
		| "feature-has-local-changes"
		| "already-landed"
		| "destination-has-local-changes"
		| "destination-checkout-blocked"
		| "ready"
		| null;
}

export async function handleStatusCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const repo = await inspectRepo(pi, ctx.cwd);
	if (!repo) {
		reportMessage(ctx, "/wt must be run inside a git repository", "error");
		return;
	}

	const isDefaultBranch =
		repo.currentBranch && repo.defaultBranch
			? normalizeBranchName(repo.currentBranch) === normalizeBranchName(repo.defaultBranch)
			: false;
	const facts = await inspectCurrentBranchFacts(pi, repo, {
		includePullRequest: !isDefaultBranch,
		changeMode: !isDefaultBranch ? "all" : "none",
	});
	const localChangesCount = facts.changes?.length ?? 0;
	const trackedChanges = !isDefaultBranch && facts.branch ? await readTrackedWorktreeChanges(pi, repo.cwd) : [];
	const ghAvailable = !isDefaultBranch && facts.branch ? await hasGhCli(pi, repo.cwd) : false;
	const landingReadiness =
		!isDefaultBranch && facts.branch
			? evaluateLandingReadiness(
					await inspectLandingFacts(pi, repo, repo.cwd, {
						includePullRequest: true,
						includeMergeState: true,
						featureChanges: "all",
						destinationChanges: "all",
					}),
				).kind
			: null;
	const actionHints = buildStatusActionHints({
		hasBranch: facts.branch !== null,
		isDefaultBranch: facts.isDefaultBranch,
		hasLinkedWorktree: Boolean(facts.worktree && !facts.worktree.isMainCheckout),
		hasBaseBranch: facts.baseBranch !== null,
		hasPullRequest: facts.pullRequest !== null,
		ghAvailable,
		localChangesCount,
		trackedChangesCount: trackedChanges.length,
		landingReadiness,
	});

	const lines = [
		`Repo root: ${repo.repoRoot}`,
		`Main checkout: ${repo.mainCheckoutPath}`,
		`Current cwd: ${repo.cwd}`,
		`Workspace: ${describeCurrentWorkspace(facts.worktree ?? undefined)}`,
		`Branch: ${facts.branch ?? "(detached HEAD)"}`,
		`Default branch: ${repo.defaultBranch ?? "(unknown)"}`,
		...(facts.isDefaultBranch
			? []
			: [
					`Detected base: ${facts.baseBranch ? `${facts.baseBranch.name} (${facts.baseBranch.source})` : "(none)"}`,
					`Local changes: ${localChangesCount}`,
					facts.pullRequest
						? `PR: #${facts.pullRequest.number} ${facts.pullRequest.title} [${formatPrState(facts.pullRequest)}]\n  ${facts.pullRequest.url}`
						: ghAvailable
							? "PR: (none)"
							: "PR: gh CLI not available",
				]),
		...(actionHints.length > 0
			? ["", "Suggested next:", ...actionHints.map((hint) => `- ${hint.command} — ${hint.detail}`)]
			: []),
	];

	reportMessage(ctx, lines.join("\n"), "info");
}

export function buildStatusActionHints(options: BuildStatusActionHintsOptions): StatusActionHint[] {
	if (!options.hasBranch) {
		return [];
	}
	if (options.isDefaultBranch) {
		return [
			{
				command: "/wt",
				detail: options.hasLinkedWorktree
					? "switch sessions, archive this linked worktree, or create another worktree"
					: "switch worktrees or create a new feature worktree",
			},
		];
	}

	const hints: StatusActionHint[] = [];
	if (options.hasBaseBranch) {
		if (options.trackedChangesCount === 0) {
			hints.push({
				command: "/wt rebase",
				detail: "update this branch onto its detected base branch",
			});
		}
	} else {
		hints.push({
			command: "/wt rebase <branch>",
			detail: "rebase onto an explicit base branch when detection is missing",
		});
	}

	if (options.ghAvailable) {
		if (options.hasBaseBranch) {
			hints.push({
				command: "/wt pr",
				detail: options.hasPullRequest
					? options.localChangesCount > 0
						? "view the current PR; the command will prompt to commit local changes first"
						: "view the current PR or push updates"
					: options.localChangesCount > 0
						? "create a PR; the command will prompt to commit local changes first"
						: "create a PR against the detected base branch",
			});
		} else {
			hints.push({
				command: "/wt pr <branch>",
				detail: "create or view a PR against an explicit base branch",
			});
		}
	}

	if (options.landingReadiness === "ready") {
		hints.push({
			command: "/wt land",
			detail: "rebase, fast-forward merge, and archive this worktree by default",
		});
	} else if (options.landingReadiness === "feature-has-local-changes") {
		hints.push({
			command: "/wt land",
			detail: "land this branch; the command will prompt to commit local changes first",
		});
	} else if (options.landingReadiness === "already-landed" && options.hasLinkedWorktree) {
		hints.push({
			command: "/wt",
			detail: "archive or switch away from this already-landed linked worktree",
		});
	}

	return hints;
}
