import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { inspectRepo } from "./git.js";
import type { BranchInfo, WtCommand } from "./types.js";

const WT_SUBCOMMAND_COMPLETIONS = [
	{ value: "status", label: "show current worktree, branch, base branch, and PR info" },
	{ value: "land", label: "land the current branch into its detected base branch and auto-archive by default" },
	{
		value: "rebase",
		label: "update the current branch by rebasing onto its detected base branch; requires a clean working tree",
	},
	{ value: "pr", label: "view or create a PR for the current branch" },
	{ value: "editor", label: "open the current worktree in your configured editor (alias: edit)" },
	{ value: "terminal", label: "open the current worktree in your configured terminal (alias: term)" },
	{ value: "help", label: "show /wt usage" },
];
const BRANCH_COMPLETION_CACHE_TTL_MS = 5000;

let cachedBranchCompletions:
	| {
			cwd: string;
			expiresAt: number;
			items: Array<{ value: string; label: string; description?: string }>;
	  }
	| undefined;
let pendingBranchCompletionRequest:
	| {
			cwd: string;
			promise: Promise<Array<{ value: string; label: string; description?: string }> | null>;
	  }
	| undefined;

export async function getWtArgumentCompletions(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string | undefined,
	prefix: string,
) {
	const trimmed = prefix.trimStart();
	if (!trimmed.includes(" ")) {
		const filtered = WT_SUBCOMMAND_COMPLETIONS.filter((item) => item.value.startsWith(trimmed));
		return filtered.length > 0 ? filtered : null;
	}

	const [subcommand, ...rest] = trimmed.split(/\s+/);
	if (subcommand !== "rebase" && subcommand !== "pr") {
		return null;
	}

	const branchPrefix = rest.join(" ").trim();
	if (branchPrefix.includes(" ")) {
		return null;
	}

	const branches = await readCachedBranchCompletions(pi, cwd);
	if (!branches || branches.length === 0) {
		return null;
	}

	const filtered = filterBranchCompletions(branches, branchPrefix);
	return filtered.length > 0 ? filtered : null;
}

async function readCachedBranchCompletions(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string | undefined,
): Promise<Array<{ value: string; label: string; description?: string }> | null> {
	if (!cwd) {
		return null;
	}

	const now = Date.now();
	if (cachedBranchCompletions?.cwd === cwd && cachedBranchCompletions.expiresAt > now) {
		return cachedBranchCompletions.items;
	}
	if (pendingBranchCompletionRequest?.cwd === cwd) {
		return await pendingBranchCompletionRequest.promise;
	}

	const promise = (async () => {
		const repo = await inspectRepo(pi, cwd);
		if (!repo) {
			return null;
		}

		const items = repo.branches.filter((branch) => !branch.isCurrent).map(toBranchCompletionItem);
		cachedBranchCompletions = {
			cwd,
			expiresAt: Date.now() + BRANCH_COMPLETION_CACHE_TTL_MS,
			items,
		};
		return items;
	})();
	pendingBranchCompletionRequest = { cwd, promise };

	try {
		return await promise;
	} finally {
		if (pendingBranchCompletionRequest?.promise === promise) {
			pendingBranchCompletionRequest = undefined;
		}
	}
}

function toBranchCompletionItem(branch: BranchInfo): { value: string; label: string; description?: string } {
	const details = [
		branch.isDefault ? "default" : null,
		branch.worktreePath ? `checked out · ${branch.worktreePath}` : null,
	]
		.filter(Boolean)
		.join(" · ");
	return {
		value: branch.name,
		label: branch.name,
		description: details || undefined,
	};
}

function filterBranchCompletions(
	branches: Array<{ value: string; label: string; description?: string }>,
	branchPrefix: string,
): Array<{ value: string; label: string; description?: string }> {
	if (!branchPrefix) {
		return branches;
	}

	const loweredPrefix = branchPrefix.toLowerCase();
	const startsWithMatches = branches.filter((branch) => branch.value.toLowerCase().startsWith(loweredPrefix));
	if (startsWithMatches.length > 0) {
		return startsWithMatches;
	}

	return branches.filter((branch) => branch.value.toLowerCase().includes(loweredPrefix));
}

export function parseWtCommand(args: string): WtCommand {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "workspace" };

	const [subcommand, ...rest] = trimmed.split(/\s+/);
	const normalized = subcommand.toLowerCase();
	const trailing = rest.join(" ").trim();

	if (normalized === "status") {
		if (trailing) throw new Error("Usage: /wt status");
		return { kind: "status" };
	}

	if (normalized === "land") {
		if (trailing) throw new Error("Usage: /wt land");
		return { kind: "land" };
	}

	if (normalized === "rebase") {
		return { kind: "rebase", explicitBase: trailing || undefined };
	}

	if (normalized === "pr") {
		return { kind: "pr", explicitBase: trailing || undefined };
	}

	if (normalized === "editor" || normalized === "edit") {
		if (trailing) throw new Error("Usage: /wt editor");
		return { kind: "editor" };
	}

	if (normalized === "terminal" || normalized === "term") {
		if (trailing) throw new Error("Usage: /wt terminal");
		return { kind: "terminal" };
	}

	if (normalized === "help") {
		return { kind: "help" };
	}

	throw new Error(wtUsageText());
}

export function wtUsageText(): string {
	return [
		"Usage:",
		"/wt               Open the worktree list and choose a session, or create one if none exists",
		"/wt status        Show current branch, base branch, and PR info",
		"/wt land          Rebase current branch onto its detected base branch, fast-forward merge into the base branch, and auto-archive by default (disable with wt.archiveAfterLand = false)",
		"/wt rebase [base] Update current branch by rebasing onto detected or explicit base branch; requires a clean working tree",
		"/wt pr [base]     View current PR, or create one against detected or explicit base branch",
		"/wt editor        Open the current worktree in your configured editor (alias: /wt edit)",
		"/wt terminal      Open the current worktree in your configured terminal (alias: /wt term)",
	].join("\n");
}
