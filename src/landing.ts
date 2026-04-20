import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	findWorktreeByBranch,
	hasMergedPullRequestAtHead,
	inspectBranchFacts,
	type WorktreeChangeMode,
} from "./branch-facts.js";
import { normalizeBranchName, readWorktreeChanges } from "./git.js";
import { formatChangesPreview, safeRealpath } from "./shared.js";
import type { BaseBranchSelection, PullRequestInfo, RepoState, WorkspaceTarget, WorktreeInfo } from "./types.js";

export interface LandingDestination {
	workspace: WorkspaceTarget;
	requiresCheckout: boolean;
}

export interface LandingInspectionOptions {
	includePullRequest?: boolean;
	includeMergeState?: boolean;
	featureChanges?: WorktreeChangeMode;
	destinationChanges?: WorktreeChangeMode;
}

export interface LandingFacts {
	requestedWorktreePath: string;
	featureWorktree: WorktreeInfo | null;
	featureBranch: string | null;
	baseBranch: BaseBranchSelection | null;
	destination: LandingDestination | null;
	destinationIsFeatureWorktree: boolean;
	featureChanges: string[] | null;
	destinationChanges: string[] | null;
	currentFeatureHead: string | null;
	pullRequest: PullRequestInfo | null;
	alreadyMergedIntoBase: boolean | null;
	mergedPullRequestAtHead: boolean;
}

export interface ReadyLandingFacts extends LandingFacts {
	featureWorktree: WorktreeInfo;
	featureBranch: string;
	baseBranch: BaseBranchSelection;
	destination: LandingDestination;
}

export function isReadyLandingFacts(facts: LandingFacts): facts is ReadyLandingFacts {
	return (
		facts.featureWorktree !== null &&
		facts.featureBranch !== null &&
		facts.baseBranch !== null &&
		facts.destination !== null
	);
}

export type LandingReadinessKind =
	| "missing-feature-worktree"
	| "detached-head"
	| "missing-base-branch"
	| "same-branch"
	| "missing-destination"
	| "feature-has-local-changes"
	| "already-landed"
	| "destination-has-local-changes"
	| "destination-checkout-blocked"
	| "ready";

export interface LandingReadiness {
	kind: LandingReadinessKind;
	details?: string;
}

export interface LandingReadinessMessage {
	level: "info" | "error";
	message: string;
}

export async function inspectLandingFacts(
	pi: ExtensionAPI,
	repo: RepoState,
	worktreePath: string,
	options: LandingInspectionOptions = {},
): Promise<LandingFacts> {
	const feature = await inspectBranchFacts(pi, repo, worktreePath, {
		includePullRequest: options.includePullRequest === true,
		changeMode: options.featureChanges,
		includeMergeState: options.includeMergeState,
	});
	const destination =
		feature.worktree && feature.baseBranch
			? resolveLandingDestination(repo, feature.worktree, feature.baseBranch.name)
			: null;
	const destinationIsFeatureWorktree =
		feature.worktree !== null &&
		destination !== null &&
		safeRealpath(destination.workspace.cwd) === feature.worktree.path;
	const destinationChanges =
		options.destinationChanges && destination
			? await readDestinationChanges(pi, destination.workspace.cwd, options.destinationChanges)
			: null;

	return {
		requestedWorktreePath: feature.requestedWorktreePath,
		featureWorktree: feature.worktree,
		featureBranch: feature.branch,
		baseBranch: feature.baseBranch,
		destination,
		destinationIsFeatureWorktree,
		featureChanges: feature.changes,
		destinationChanges,
		currentFeatureHead: feature.currentHead,
		pullRequest: feature.pullRequest,
		alreadyMergedIntoBase: feature.mergedIntoTarget,
		mergedPullRequestAtHead: hasMergedPullRequestAtHead(feature),
	};
}

export function evaluateLandingReadiness(facts: LandingFacts): LandingReadiness {
	if (!facts.featureWorktree) {
		return { kind: "missing-feature-worktree" };
	}
	if (!facts.featureBranch) {
		return { kind: "detached-head" };
	}
	if (!facts.baseBranch) {
		return { kind: "missing-base-branch" };
	}
	if (normalizeBranchName(facts.baseBranch.name) === normalizeBranchName(facts.featureBranch)) {
		return { kind: "same-branch" };
	}
	if (!facts.destination) {
		return { kind: "missing-destination" };
	}
	if ((facts.featureChanges?.length ?? 0) > 0) {
		return { kind: "feature-has-local-changes" };
	}
	if (facts.alreadyMergedIntoBase || facts.mergedPullRequestAtHead) {
		return {
			kind: "already-landed",
			details: facts.alreadyMergedIntoBase
				? `${facts.featureBranch} is already merged into ${facts.baseBranch.name}.`
				: `${facts.featureBranch} already has a merged PR into ${facts.baseBranch.name} (#${facts.pullRequest?.number}).`,
		};
	}
	if ((facts.destinationChanges?.length ?? 0) > 0 && !facts.destinationIsFeatureWorktree) {
		return { kind: "destination-has-local-changes" };
	}
	if ((facts.destinationChanges?.length ?? 0) > 0 && facts.destinationIsFeatureWorktree) {
		return { kind: "destination-checkout-blocked" };
	}
	return { kind: "ready" };
}

export function formatLandingReadinessMessage(
	facts: LandingFacts,
	readiness: LandingReadiness,
): LandingReadinessMessage | null {
	switch (readiness.kind) {
		case "missing-feature-worktree":
			return {
				level: "error",
				message: `Could not find a worktree at ${facts.requestedWorktreePath}.`,
			};
		case "detached-head":
			return {
				level: "error",
				message: `Cannot land ${facts.featureWorktree?.path ?? facts.requestedWorktreePath} from detached HEAD.`,
			};
		case "missing-base-branch":
			return {
				level: "error",
				message: "Could not determine a base branch. Try /wt status or configure branch.<name>.wt-parent.",
			};
		case "same-branch":
			return {
				level: "error",
				message: `Refusing to land ${facts.featureBranch} into itself`,
			};
		case "missing-destination":
			return {
				level: "error",
				message: `Could not find a safe checkout for base branch ${facts.baseBranch?.name}.`,
			};
		case "feature-has-local-changes":
			return {
				level: "error",
				message: [
					`Cannot land ${facts.featureBranch}: feature worktree ${facts.featureWorktree?.path} still has local changes (${facts.featureChanges?.length ?? 0}).`,
					"Commit, stash, or discard them first.",
					formatChangesPreview(facts.featureChanges ?? []),
				]
					.filter(Boolean)
					.join("\n"),
			};
		case "already-landed":
			return {
				level: "info",
				message: [readiness.details ?? `${facts.featureBranch} is already landed.`, "Nothing to land."]
					.filter(Boolean)
					.join("\n"),
			};
		case "destination-has-local-changes":
			return {
				level: "error",
				message: [
					`Cannot land ${facts.featureBranch}: destination checkout ${facts.destination?.workspace.cwd} has local changes (${facts.destinationChanges?.length ?? 0}).`,
					"Clean that checkout first.",
					formatChangesPreview(facts.destinationChanges ?? []),
				]
					.filter(Boolean)
					.join("\n"),
			};
		case "destination-checkout-blocked":
			return {
				level: "error",
				message: [
					`Cannot check out ${facts.baseBranch?.name} in ${facts.destination?.workspace.cwd} because it still has local changes (${facts.destinationChanges?.length ?? 0}).`,
					"Commit, stash, or discard them first.",
					formatChangesPreview(facts.destinationChanges ?? []),
				]
					.filter(Boolean)
					.join("\n"),
			};
		case "ready":
			return null;
	}
}

function resolveLandingDestination(
	repo: RepoState,
	featureWorktree: WorktreeInfo,
	baseBranchName: string,
): LandingDestination | null {
	const matchingWorktree = findWorktreeByBranch(repo, baseBranchName, featureWorktree.path);
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
		requiresCheckout: normalizeBranchName(mainCheckout.branch ?? "") !== normalizeBranchName(baseBranchName),
	};
}

async function readDestinationChanges(
	pi: ExtensionAPI,
	cwd: string,
	mode: WorktreeChangeMode,
): Promise<string[] | null> {
	if (mode === "none") {
		return null;
	}
	return readWorktreeChanges(pi, cwd, mode === "all");
}
