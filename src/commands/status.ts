import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { detectBaseBranch, formatPrState, inspectRepo, normalizeBranchName, readCurrentPr } from "../git.js";
import { reportMessage } from "../shared.js";
import { describeCurrentWorkspace } from "../worktrees.js";

export async function handleStatusCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const repo = await inspectRepo(pi, ctx.cwd);
	if (!repo) {
		reportMessage(ctx, "/wt must be run inside a git repository", "error");
		return;
	}

	const currentWorktree = repo.worktrees.find((worktree) => worktree.isCurrent);
	const isDefaultBranch =
		repo.currentBranch && repo.defaultBranch
			? normalizeBranchName(repo.currentBranch) === normalizeBranchName(repo.defaultBranch)
			: false;
	const pr = isDefaultBranch ? null : await readCurrentPr(pi, repo.cwd);
	const baseBranch =
		repo.currentBranch && !isDefaultBranch ? await detectBaseBranch(pi, repo, repo.cwd, repo.currentBranch) : null;

	const lines = [
		`Repo root: ${repo.repoRoot}`,
		`Main checkout: ${repo.mainCheckoutPath}`,
		`Current cwd: ${repo.cwd}`,
		`Workspace: ${describeCurrentWorkspace(currentWorktree)}`,
		`Branch: ${repo.currentBranch ?? "(detached HEAD)"}`,
		`Default branch: ${repo.defaultBranch ?? "(unknown)"}`,
		...(isDefaultBranch
			? []
			: [
					`Detected base: ${baseBranch ? `${baseBranch.name} (${baseBranch.source})` : "(none)"}`,
					pr ? `PR: #${pr.number} ${pr.title} [${formatPrState(pr)}]\n  ${pr.url}` : "PR: (none)",
				]),
	];

	reportMessage(ctx, lines.join("\n"), "info");
}
