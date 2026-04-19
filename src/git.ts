import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { safeRealpath } from "./shared.js";
import {
	type BaseBranchSelection,
	type BranchInfo,
	type ExecResult,
	type PullRequestInfo,
	type RepoState,
	type WorktreeInfo,
	WT_STATE_STATUS_KEY,
} from "./types.js";

export async function inspectRepo(pi: ExtensionAPI, cwd: string): Promise<RepoState | null> {
	const topLevel = await exec(pi, "git", ["rev-parse", "--show-toplevel"], cwd);
	if (topLevel.code !== 0) {
		return null;
	}

	const repoRoot = safeRealpath(topLevel.stdout.trim());
	const commonDir = await resolveGitCommonDir(pi, repoRoot);
	const mainCheckoutPath = basename(commonDir) === ".git" ? safeRealpath(dirname(commonDir)) : repoRoot;

	const [currentBranchResult, defaultBranchResult, worktreeResult, branchesResult] = await Promise.all([
		exec(pi, "git", ["branch", "--show-current"], repoRoot),
		exec(pi, "git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoRoot),
		exec(pi, "git", ["worktree", "list", "--porcelain"], repoRoot),
		exec(pi, "git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], repoRoot),
	]);

	if (worktreeResult.code !== 0) {
		throw new Error(worktreeResult.stderr.trim() || "Failed to list git worktrees");
	}

	if (branchesResult.code !== 0) {
		throw new Error(branchesResult.stderr.trim() || "Failed to list local git branches");
	}

	const currentBranch = currentBranchResult.stdout.trim() || null;
	const defaultBranchRaw = defaultBranchResult.stdout.trim();
	const defaultBranch = defaultBranchRaw ? defaultBranchRaw.replace(/^origin\//, "") : null;
	const worktrees = parseWorktrees(worktreeResult.stdout, cwd, mainCheckoutPath);
	const worktreeMap = new Map(
		worktrees.filter((worktree) => worktree.branch).map((worktree) => [worktree.branch as string, worktree.path]),
	);

	const branches = branchesResult.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((name) => ({
			name,
			isCurrent: name === currentBranch,
			isDefault: name === defaultBranch,
			worktreePath: worktreeMap.get(name) ?? null,
		}))
		.sort(compareBranches);

	return {
		cwd: safeRealpath(cwd),
		repoRoot,
		mainCheckoutPath,
		currentBranch,
		defaultBranch,
		worktrees: worktrees.sort(compareWorktrees),
		branches,
	};
}

async function resolveGitCommonDir(pi: ExtensionAPI, repoRoot: string): Promise<string> {
	const absolute = await exec(pi, "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], repoRoot);
	if (absolute.code === 0) {
		return safeRealpath(absolute.stdout.trim());
	}

	const fallback = await exec(pi, "git", ["rev-parse", "--git-common-dir"], repoRoot);
	if (fallback.code !== 0) {
		throw new Error(fallback.stderr.trim() || "Failed to resolve git common dir");
	}

	const raw = fallback.stdout.trim();
	return safeRealpath(isAbsolute(raw) ? raw : resolve(repoRoot, raw));
}

function parseWorktrees(output: string, currentCwd: string, mainCheckoutPath: string): WorktreeInfo[] {
	const currentReal = safeRealpath(currentCwd);
	const mainReal = safeRealpath(mainCheckoutPath);
	const blocks = output
		.trim()
		.split(/\n\s*\n/g)
		.map((block) => block.trim())
		.filter(Boolean);

	return blocks
		.map((block) => {
			const lines = block.split("\n");
			let path = "";
			let branch: string | null = null;
			let head: string | null = null;
			let detached = false;
			let locked: string | null = null;
			let prunable: string | null = null;

			for (const line of lines) {
				if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
				else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
				else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
				else if (line === "detached") detached = true;
				else if (line.startsWith("locked")) locked = line.slice("locked".length).trim() || "locked";
				else if (line.startsWith("prunable")) prunable = line.slice("prunable".length).trim() || "prunable";
			}

			if (!path) return undefined;
			const resolvedPath = safeRealpath(path);
			return {
				path: resolvedPath,
				branch,
				head,
				detached,
				locked,
				prunable,
				isCurrent: resolvedPath === currentReal,
				isMainCheckout: resolvedPath === mainReal,
			} satisfies WorktreeInfo;
		})
		.filter((value): value is WorktreeInfo => Boolean(value));
}

export async function detectBaseBranch(
	pi: ExtensionAPI,
	repo: RepoState,
	cwd: string,
	currentBranch: string,
	explicitBase?: string,
): Promise<BaseBranchSelection | null> {
	if (explicitBase?.trim()) {
		return resolveBaseBranchSelection(pi, cwd, explicitBase.trim(), "explicit argument");
	}

	const pr = await readCurrentPr(pi, cwd);
	if (pr?.baseRefName) {
		return resolveBaseBranchSelection(pi, cwd, pr.baseRefName, "current PR base");
	}

	const storedParent = await readGitConfig(pi, cwd, `branch.${currentBranch}.wt-parent`);
	if (storedParent) {
		return resolveBaseBranchSelection(
			pi,
			cwd,
			storedParent,
			`configured base branch (branch.${currentBranch}.wt-parent)`,
		);
	}

	const ghMergeBase = await readGitConfig(pi, cwd, `branch.${currentBranch}.gh-merge-base`);
	if (ghMergeBase) {
		return resolveBaseBranchSelection(
			pi,
			cwd,
			ghMergeBase,
			`configured base branch (branch.${currentBranch}.gh-merge-base)`,
		);
	}

	if (repo.defaultBranch) {
		return resolveBaseBranchSelection(pi, cwd, repo.defaultBranch, "default branch");
	}

	return null;
}

async function resolveBaseBranchSelection(
	pi: ExtensionAPI,
	cwd: string,
	branchish: string,
	source: string,
): Promise<BaseBranchSelection> {
	const normalizedName = normalizeBranchName(branchish);
	const directRef = await verifyRef(pi, cwd, branchish);
	if (directRef) {
		return { name: normalizedName, ref: branchish, source };
	}

	if (await refExists(pi, cwd, `refs/heads/${normalizedName}`)) {
		return { name: normalizedName, ref: normalizedName, source };
	}

	if (await refExists(pi, cwd, `refs/remotes/origin/${normalizedName}`)) {
		return { name: normalizedName, ref: `origin/${normalizedName}`, source };
	}

	return { name: normalizedName, ref: normalizedName, source };
}

export async function hasGhCli(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const result = await exec(pi, "gh", ["--version"], cwd);
	return result.code === 0;
}

export async function readCurrentPr(pi: ExtensionAPI, cwd: string): Promise<PullRequestInfo | null> {
	if (!(await hasGhCli(pi, cwd))) {
		return null;
	}

	const result = await exec(
		pi,
		"gh",
		["pr", "view", "--json", "number,title,url,state,isDraft,baseRefName,headRefName"],
		cwd,
	);
	if (result.code !== 0) {
		return null;
	}

	try {
		const parsed = JSON.parse(result.stdout) as PullRequestInfo;
		return parsed?.url ? parsed : null;
	} catch {
		return null;
	}
}

export async function readGitConfig(pi: ExtensionAPI, cwd: string, key: string): Promise<string | null> {
	const result = await exec(pi, "git", ["config", "--get", key], cwd);
	const value = result.stdout.trim();
	return result.code === 0 && value ? value : null;
}

export async function writeGitConfig(pi: ExtensionAPI, cwd: string, key: string, value: string): Promise<void> {
	const result = await exec(pi, "git", ["config", key, value], cwd);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `Failed to set git config ${key}`);
	}
}

export async function refreshWorktreeStateStatus(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	const repo = await inspectRepo(pi, ctx.cwd);
	if (!repo) {
		ctx.ui.setStatus(WT_STATE_STATUS_KEY, undefined);
		return;
	}

	const trackedChanges = await readTrackedWorktreeChanges(pi, repo.cwd);
	ctx.ui.setStatus(
		WT_STATE_STATUS_KEY,
		trackedChanges.length > 0
			? ctx.ui.theme.fg(
					"error",
					`/wt rebase blocked: tracked changes (${trackedChanges.length}) — clean working tree required`,
				)
			: undefined,
	);
}

export async function readTrackedWorktreeChanges(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const result = await exec(pi, "git", ["status", "--short", "--untracked-files=no"], cwd);
	if (result.code !== 0) {
		return [];
	}

	return result.stdout
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter(Boolean);
}

export async function readWorktreeChanges(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	return readTrackedWorktreeChanges(pi, cwd);
}

async function verifyRef(pi: ExtensionAPI, cwd: string, branchish: string): Promise<boolean> {
	const result = await exec(pi, "git", ["rev-parse", "--verify", "--quiet", branchish], cwd);
	return result.code === 0;
}

async function refExists(pi: ExtensionAPI, cwd: string, ref: string): Promise<boolean> {
	const result = await exec(pi, "git", ["show-ref", "--verify", "--quiet", ref], cwd);
	return result.code === 0;
}

export function normalizeBranchName(branchish: string): string {
	return branchish
		.replace(/^refs\/heads\//, "")
		.replace(/^refs\/remotes\/origin\//, "")
		.replace(/^origin\//, "");
}

export function formatPrState(pr: PullRequestInfo): string {
	return pr.isDraft ? `${pr.state} draft` : pr.state;
}

export function summarizeCommandOutput(result: ExecResult): string {
	return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

function compareWorktrees(left: WorktreeInfo, right: WorktreeInfo): number {
	const leftPriority = left.isCurrent ? 0 : left.isMainCheckout ? 1 : 2;
	const rightPriority = right.isCurrent ? 0 : right.isMainCheckout ? 1 : 2;
	if (leftPriority !== rightPriority) return leftPriority - rightPriority;
	return workspaceBranchLabel(left).localeCompare(workspaceBranchLabel(right));
}

function compareBranches(left: BranchInfo, right: BranchInfo): number {
	const leftPriority = left.isCurrent ? 0 : left.isDefault ? 1 : 2;
	const rightPriority = right.isCurrent ? 0 : right.isDefault ? 1 : 2;
	if (leftPriority !== rightPriority) return leftPriority - rightPriority;
	return left.name.localeCompare(right.name);
}

function workspaceBranchLabel(worktree: WorktreeInfo): string {
	return worktree.branch ?? shortHead(worktree.head) ?? basename(worktree.path);
}

function shortHead(head: string | null): string | null {
	return head ? head.slice(0, 8) : null;
}

export async function exec(pi: ExtensionAPI, command: string, args: string[], cwd: string): Promise<ExecResult> {
	const result = await pi.exec(command, args, { cwd });
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		code: result.code ?? null,
	};
}

export async function execShell(pi: ExtensionAPI, command: string, cwd: string): Promise<ExecResult> {
	const shell = process.env.SHELL || "bash";
	return exec(pi, shell, ["-lc", command], cwd);
}
