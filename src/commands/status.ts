import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { inspectCurrentBranchFacts } from "../branch-facts.js";
import { formatPrState, inspectRepo, normalizeBranchName } from "../git.js";
import { reportMessage } from "../shared.js";
import { describeCurrentWorkspace } from "../worktrees.js";

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
	const facts = await inspectCurrentBranchFacts(pi, repo, { includePullRequest: !isDefaultBranch });

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
					facts.pullRequest
						? `PR: #${facts.pullRequest.number} ${facts.pullRequest.title} [${formatPrState(facts.pullRequest)}]\n  ${facts.pullRequest.url}`
						: "PR: (none)",
				]),
	];

	reportMessage(ctx, lines.join("\n"), "info");
}
