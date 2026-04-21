import { sep } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	detectBaseBranch,
	exec,
	hasGhCli,
	inspectRepo,
	isBranchMergedInto,
	normalizeBranchName,
	readCurrentPr,
	readTrackedWorktreeChanges,
	readWorktreeChanges,
} from "./git.js";
import { safeRealpath } from "./shared.js";
import type { BaseBranchSelection, PullRequestInfo, RepoState, WorktreeInfo } from "./types.js";

export type WorktreeChangeMode = "none" | "tracked" | "all";

export interface BranchInspectionOptions {
	explicitBase?: string;
	includePullRequest?: boolean;
	pullRequest?: PullRequestInfo | null;
	changeMode?: WorktreeChangeMode;
	includeMergeState?: boolean;
	mergeTarget?: string;
}

export interface BranchFacts {
	requestedWorktreePath: string;
	worktree: WorktreeInfo | null;
	branch: string | null;
	isDetached: boolean;
	isDefaultBranch: boolean;
	baseBranch: BaseBranchSelection | null;
	pullRequest: PullRequestInfo | null;
	changes: string[] | null;
	currentHead: string | null;
	mergeTarget: string | null;
	mergedIntoTarget: boolean | null;
}

export async function inspectCurrentBranchFacts(
	pi: ExtensionAPI,
	repo: RepoState,
	options: BranchInspectionOptions = {},
): Promise<BranchFacts> {
	const currentWorktree = repo.worktrees.find((worktree) => worktree.isCurrent);
	return inspectBranchFacts(pi, repo, currentWorktree?.path ?? repo.cwd, options);
}

export async function inspectBranchFacts(
	pi: ExtensionAPI,
	repo: RepoState,
	worktreePath: string,
	options: BranchInspectionOptions = {},
): Promise<BranchFacts> {
	const requestedWorktreePath = safeRealpath(worktreePath);
	const worktree = resolveWorktreeByPath(repo, requestedWorktreePath) ?? null;
	const branch = worktree?.branch ?? null;
	const isDetached = worktree !== null && branch === null;
	const isDefaultBranch =
		branch !== null && repo.defaultBranch !== null
			? normalizeBranchName(branch) === normalizeBranchName(repo.defaultBranch)
			: false;
	const includePullRequest = options.includePullRequest !== false;
	const pullRequest =
		options.pullRequest !== undefined
			? options.pullRequest
			: includePullRequest && worktree && branch
				? await readCurrentPr(pi, worktree.path)
				: null;
	const baseBranch =
		worktree && branch
			? await detectBaseBranch(pi, repo, worktree.path, branch, options.explicitBase, {
					includePullRequest,
					pullRequest,
				})
			: null;
	const mergeTarget = options.includeMergeState ? (options.mergeTarget ?? baseBranch?.ref ?? null) : null;
	const shouldReadHead = (options.includeMergeState || pullRequest !== null) && worktree !== null && branch !== null;
	const [changes, currentHead, mergedIntoTarget] = await Promise.all([
		readChangesForMode(pi, worktree?.path, options.changeMode),
		shouldReadHead ? readCurrentHead(pi, worktree.path) : Promise.resolve(null),
		mergeTarget && worktree && branch
			? isBranchMergedInto(pi, worktree.path, branch, mergeTarget)
			: Promise.resolve(null),
	]);

	return {
		requestedWorktreePath,
		worktree,
		branch,
		isDetached,
		isDefaultBranch,
		baseBranch,
		pullRequest,
		changes,
		currentHead,
		mergeTarget,
		mergedIntoTarget,
	};
}

export async function buildWorktreeSystemPromptContext(
	pi: ExtensionAPI,
	cwd: string,
	prompt: string,
): Promise<string | null> {
	const repo = await inspectRepo(pi, cwd);
	if (!repo) {
		return null;
	}

	const currentWorktree = repo.worktrees.find((worktree) => worktree.isCurrent) ?? null;
	const facts = repo.currentBranch ? await inspectCurrentBranchFacts(pi, repo, { includePullRequest: false }) : null;
	const isLinkedWorktree = currentWorktree !== null && !currentWorktree.isMainCheckout;
	const hasFeatureBranchContext = Boolean(facts?.branch && !facts.isDefaultBranch && facts.baseBranch);
	const canLandCurrentBranch = Boolean(
		facts?.branch && !facts.isDetached && !facts.isDefaultBranch && facts.baseBranch,
	);
	if (!isLinkedWorktree && !hasFeatureBranchContext) {
		return null;
	}

	const lines = ["## pi-wt context"];
	if (isLinkedWorktree && currentWorktree) {
		lines.push(`- Linked worktree: \`${currentWorktree.path}\` on \`${facts?.branch ?? "(detached HEAD)"}\`.`);
		lines.push(
			"- Do not treat this worktree path as the repo's main checkout when reasoning about Git or file operations.",
		);
	} else if (facts?.branch) {
		lines.push(`- Current branch: \`${facts.branch}\` in the main checkout.`);
	} else if (facts?.isDetached) {
		lines.push("- Current branch: detached HEAD in the main checkout.");
	}

	if (facts?.baseBranch && !facts.isDefaultBranch) {
		lines.push(`- Base branch: \`${facts.baseBranch.name}\` (${facts.baseBranch.source}).`);
	}

	const suggestedCommands = await suggestWtCommands(
		pi,
		cwd,
		prompt,
		Boolean(facts?.baseBranch && !facts.isDefaultBranch),
		canLandCurrentBranch,
	);
	if (suggestedCommands.length > 0) {
		lines.push(`- Prefer ${formatCommandList(suggestedCommands)} when relevant.`);
	}

	return lines.join("\n");
}

async function suggestWtCommands(
	pi: ExtensionAPI,
	cwd: string,
	prompt: string,
	hasBaseBranch: boolean,
	canLandCurrentBranch: boolean,
): Promise<string[]> {
	const lowerPrompt = prompt.toLowerCase();
	const commands = new Set<string>();

	if (
		/\bworktree\b/.test(lowerPrompt) ||
		/\bworkspace\b/.test(lowerPrompt) ||
		/\bstatus\b/.test(lowerPrompt) ||
		/\bbranch\b/.test(lowerPrompt) ||
		/\bbase branch\b/.test(lowerPrompt)
	) {
		commands.add("/wt status");
	}
	if (
		hasBaseBranch &&
		(/\brebase\b/.test(lowerPrompt) || /\bsync\b/.test(lowerPrompt) || /\bupdate\b/.test(lowerPrompt))
	) {
		commands.add("/wt rebase");
	}
	if (
		canLandCurrentBranch &&
		(/\bland\b/.test(lowerPrompt) || /\bmerge\b/.test(lowerPrompt) || /\bintegrate\b/.test(lowerPrompt))
	) {
		commands.add("/wt land");
	}
	if (
		(/\bpr\b/.test(lowerPrompt) || /\bpull request\b/.test(lowerPrompt) || /\bgithub\b/.test(lowerPrompt)) &&
		(await hasGhCli(pi, cwd))
	) {
		commands.add("/wt pr");
	}

	if (commands.size === 0) {
		commands.add("/wt status");
	}

	return [...commands];
}

function formatCommandList(commands: string[]): string {
	return commands.map((command) => `\`${command}\``).join(", ");
}

export function resolveWorktreeByPath(repo: RepoState, worktreePath: string): WorktreeInfo | undefined {
	const normalizedPath = safeRealpath(worktreePath);
	return repo.worktrees.find((worktree) => pathContains(worktree.path, normalizedPath));
}

export function findWorktreeByBranch(
	repo: RepoState,
	branchName: string,
	excludeWorktreePath?: string,
): WorktreeInfo | undefined {
	const normalizedBranch = normalizeBranchName(branchName);
	const excludedPath = excludeWorktreePath ? safeRealpath(excludeWorktreePath) : null;
	return repo.worktrees.find(
		(worktree) =>
			worktree.branch !== null &&
			(excludedPath === null || worktree.path !== excludedPath) &&
			normalizeBranchName(worktree.branch) === normalizedBranch,
	);
}

export function hasMergedPullRequestAtHead(
	facts: Pick<BranchFacts, "pullRequest" | "currentHead" | "baseBranch">,
): boolean {
	return Boolean(
		facts.pullRequest?.state === "MERGED" &&
			facts.pullRequest.headRefOid &&
			facts.currentHead &&
			facts.baseBranch &&
			facts.pullRequest.headRefOid === facts.currentHead &&
			normalizeBranchName(facts.pullRequest.baseRefName) === normalizeBranchName(facts.baseBranch.name),
	);
}

async function readChangesForMode(
	pi: ExtensionAPI,
	cwd: string | undefined,
	mode: WorktreeChangeMode | undefined,
): Promise<string[] | null> {
	if (!cwd || !mode || mode === "none") {
		return null;
	}
	if (mode === "tracked") {
		return readTrackedWorktreeChanges(pi, cwd);
	}
	return readWorktreeChanges(pi, cwd, true);
}

async function readCurrentHead(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const result = await exec(pi, "git", ["rev-parse", "HEAD"], cwd);
	const head = result.stdout.trim();
	return result.code === 0 && head ? head : null;
}

function pathContains(parentPath: string, path: string): boolean {
	return path === parentPath || path.startsWith(`${parentPath}${sep}`);
}
