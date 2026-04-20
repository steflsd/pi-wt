import type { BranchFacts } from "./branch-facts.js";
import { normalizeBranchName } from "./git.js";
import { formatChangesPreview } from "./shared.js";
import type { BaseBranchSelection } from "./types.js";

export interface ReadyBranchFacts extends BranchFacts {
	branch: string;
	baseBranch: BaseBranchSelection;
}

export function isReadyBranchFacts(facts: BranchFacts): facts is ReadyBranchFacts {
	return facts.branch !== null && facts.baseBranch !== null;
}

export type RebaseReadinessKind =
	| "detached-head"
	| "missing-base-branch"
	| "same-branch"
	| "has-local-changes"
	| "ready";

export interface RebaseReadiness {
	kind: RebaseReadinessKind;
}

export function evaluateRebaseReadiness(facts: BranchFacts): RebaseReadiness {
	if (!facts.branch) {
		return { kind: "detached-head" };
	}
	if (!facts.baseBranch) {
		return { kind: "missing-base-branch" };
	}
	if (normalizeBranchName(facts.baseBranch.name) === normalizeBranchName(facts.branch)) {
		return { kind: "same-branch" };
	}
	if ((facts.changes?.length ?? 0) > 0) {
		return { kind: "has-local-changes" };
	}
	return { kind: "ready" };
}

export function formatRebaseReadinessMessage(facts: BranchFacts, readiness: RebaseReadiness): string {
	switch (readiness.kind) {
		case "detached-head":
			return "Cannot rebase from detached HEAD";
		case "missing-base-branch":
			return "Could not determine a base branch. Try /wt rebase <branch>";
		case "same-branch":
			return `Refusing to rebase ${facts.branch} onto itself`;
		case "has-local-changes": {
			const preview = formatChangesPreview(facts.changes ?? []);
			return [
				"Cannot rebase: a clean working tree is required.",
				"This worktree has tracked local changes.",
				"Commit, stash, or discard them first.",
				preview ? `\n${preview}` : "",
			]
				.filter(Boolean)
				.join("\n");
		}
		case "ready":
			return "";
	}
}

export type PrReadinessKind = "detached-head" | "missing-base-branch" | "needs-commit" | "ready";

export interface PrReadiness {
	kind: PrReadinessKind;
}

export function evaluatePrReadiness(facts: BranchFacts): PrReadiness {
	if (!facts.branch) {
		return { kind: "detached-head" };
	}
	if (!facts.baseBranch) {
		return { kind: "missing-base-branch" };
	}
	if ((facts.changes?.length ?? 0) > 0) {
		return { kind: "needs-commit" };
	}
	return { kind: "ready" };
}

export function formatPrReadinessMessage(readiness: PrReadiness): string {
	switch (readiness.kind) {
		case "detached-head":
			return "Cannot manage a PR from detached HEAD";
		case "missing-base-branch":
			return "Could not determine a base branch. Try /wt pr <branch>";
		case "needs-commit":
		case "ready":
			return "";
	}
}
