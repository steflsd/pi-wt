import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { safeRealpath } from "./shared.js";
import {
	type BaseBranchSelection,
	type BranchInfo,
	type BranchPublishPlan,
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
		exec(pi, "git", ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"], repoRoot),
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

	const branches = prioritizeBranches(
		branchesResult.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((name) => ({
				name,
				isCurrent: name === currentBranch,
				isDefault: name === defaultBranch,
				worktreePath: worktreeMap.get(name) ?? null,
			})),
	);

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
				isCurrent: pathContains(resolvedPath, currentReal),
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

	if (repo.defaultBranch && normalizeBranchName(repo.defaultBranch) !== normalizeBranchName(currentBranch)) {
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
	const ref = (await resolveBranchishRef(pi, cwd, branchish)) ?? normalizedName;
	return { name: normalizedName, ref, source };
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

export async function planCurrentBranchPublish(
	pi: ExtensionAPI,
	cwd: string,
	currentBranch: string,
): Promise<BranchPublishPlan> {
	const upstream = await readCurrentBranchUpstream(pi, cwd);
	if (upstream) {
		const aheadBehind = await readAheadBehind(pi, cwd, upstream);
		if (aheadBehind && aheadBehind.ahead > 0) {
			return {
				remote: upstreamRemoteName(upstream),
				upstream,
				needsPush: true,
				reason: `${currentBranch} is ${aheadBehind.ahead} commit(s) ahead of ${upstream}`,
				commandArgs: ["push"],
			};
		}

		return {
			remote: upstreamRemoteName(upstream),
			upstream,
			needsPush: false,
			reason: null,
			commandArgs: null,
		};
	}

	const remote = await detectPushRemote(pi, cwd, currentBranch);
	if (!remote) {
		return {
			remote: null,
			upstream: null,
			needsPush: true,
			reason: `${currentBranch} is not published and no push remote could be determined`,
			commandArgs: null,
		};
	}

	return {
		remote,
		upstream: null,
		needsPush: true,
		reason: `${currentBranch} is not published yet`,
		commandArgs: ["push", "--set-upstream", remote, currentBranch],
	};
}

export async function writeGitConfig(pi: ExtensionAPI, cwd: string, key: string, value: string): Promise<void> {
	const result = await exec(pi, "git", ["config", key, value], cwd);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `Failed to set git config ${key}`);
	}
}

export async function unsetGitConfig(pi: ExtensionAPI, cwd: string, key: string): Promise<boolean> {
	const result = await exec(pi, "git", ["config", "--unset-all", key], cwd);
	if (result.code === 0) {
		return true;
	}

	const stderr = result.stderr.trim();
	return result.code === 5 || stderr.includes("No such section or key");
}

export async function refreshWorktreeStateStatus(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cwd: string = ctx.cwd,
): Promise<void> {
	if (!ctx.hasUI) return;

	const repo = await inspectRepo(pi, cwd);
	if (!repo?.currentBranch) {
		ctx.ui.setStatus(WT_STATE_STATUS_KEY, undefined);
		return;
	}

	const currentWorktree = repo.worktrees.find((worktree) => worktree.isCurrent);
	if (!currentWorktree || currentWorktree.isMainCheckout) {
		ctx.ui.setStatus(WT_STATE_STATUS_KEY, undefined);
		return;
	}

	const baseBranch = await readGitConfig(pi, repo.cwd, `branch.${repo.currentBranch}.wt-parent`);
	if (!baseBranch) {
		ctx.ui.setStatus(WT_STATE_STATUS_KEY, undefined);
		return;
	}

	const trackedChanges = await readTrackedWorktreeChanges(pi, repo.cwd);
	ctx.ui.setStatus(
		WT_STATE_STATUS_KEY,
		trackedChanges.length > 0
			? ctx.ui.theme.fg(
					"error",
					`/wt rebase onto ${normalizeBranchName(baseBranch)} blocked: tracked changes (${trackedChanges.length}) — clean working tree required`,
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

export async function readWorktreeChanges(pi: ExtensionAPI, cwd: string, includeUntracked = false): Promise<string[]> {
	const result = await exec(
		pi,
		"git",
		includeUntracked ? ["status", "--short"] : ["status", "--short", "--untracked-files=no"],
		cwd,
	);
	if (result.code !== 0) {
		return [];
	}

	return result.stdout
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter(Boolean);
}

export async function isBranchMergedInto(
	pi: ExtensionAPI,
	cwd: string,
	branchish: string,
	baseBranchish: string,
): Promise<boolean | null> {
	const [branchRef, baseRef] = await Promise.all([
		resolveBranchishRef(pi, cwd, branchish),
		resolveBranchishRef(pi, cwd, baseBranchish),
	]);
	if (!branchRef || !baseRef) {
		return null;
	}

	const result = await exec(pi, "git", ["merge-base", "--is-ancestor", branchRef, baseRef], cwd);
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	return null;
}

async function verifyRef(pi: ExtensionAPI, cwd: string, branchish: string): Promise<boolean> {
	const result = await exec(pi, "git", ["rev-parse", "--verify", "--quiet", branchish], cwd);
	return result.code === 0;
}

async function readCurrentBranchUpstream(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const result = await exec(pi, "git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd);
	const value = result.stdout.trim();
	return result.code === 0 && value ? value : null;
}

async function readAheadBehind(
	pi: ExtensionAPI,
	cwd: string,
	upstream: string,
): Promise<{ ahead: number; behind: number } | null> {
	const result = await exec(pi, "git", ["rev-list", "--left-right", "--count", `${upstream}...HEAD`], cwd);
	if (result.code !== 0) {
		return null;
	}

	const [behindRaw, aheadRaw] = result.stdout.trim().split(/\s+/);
	const behind = Number.parseInt(behindRaw ?? "", 10);
	const ahead = Number.parseInt(aheadRaw ?? "", 10);
	if (Number.isNaN(behind) || Number.isNaN(ahead)) {
		return null;
	}

	return { ahead, behind };
}

async function detectPushRemote(pi: ExtensionAPI, cwd: string, currentBranch: string): Promise<string | null> {
	const remotes = await listGitRemotes(pi, cwd);
	if (remotes.length === 0) {
		return null;
	}

	const configuredRemote =
		(await readGitConfig(pi, cwd, `branch.${currentBranch}.pushRemote`)) ??
		(await readGitConfig(pi, cwd, "remote.pushDefault")) ??
		(await readGitConfig(pi, cwd, `branch.${currentBranch}.remote`));
	if (configuredRemote && remotes.includes(configuredRemote)) {
		return configuredRemote;
	}

	if (remotes.includes("origin")) {
		return "origin";
	}

	return remotes.length === 1 ? remotes[0] : null;
}

async function listGitRemotes(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const result = await exec(pi, "git", ["remote"], cwd);
	if (result.code !== 0) {
		return [];
	}

	return result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

function upstreamRemoteName(upstream: string): string | null {
	const [remote] = upstream.split("/", 1);
	return remote || null;
}

async function refExists(pi: ExtensionAPI, cwd: string, ref: string): Promise<boolean> {
	const result = await exec(pi, "git", ["show-ref", "--verify", "--quiet", ref], cwd);
	return result.code === 0;
}

async function resolveBranchishRef(pi: ExtensionAPI, cwd: string, branchish: string): Promise<string | null> {
	const normalizedName = normalizeBranchName(branchish);
	if (await verifyRef(pi, cwd, branchish)) {
		return branchish;
	}

	if (await refExists(pi, cwd, `refs/heads/${normalizedName}`)) {
		return normalizedName;
	}

	if (await refExists(pi, cwd, `refs/remotes/origin/${normalizedName}`)) {
		return `origin/${normalizedName}`;
	}

	return null;
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

function prioritizeBranches(branches: BranchInfo[]): BranchInfo[] {
	const current = branches.filter((branch) => branch.isCurrent);
	const defaults = branches.filter((branch) => branch.isDefault && !branch.isCurrent);
	const rest = branches.filter((branch) => !branch.isCurrent && !branch.isDefault);
	return [...current, ...defaults, ...rest];
}

function workspaceBranchLabel(worktree: WorktreeInfo): string {
	return worktree.branch ?? shortHead(worktree.head) ?? basename(worktree.path);
}

function shortHead(head: string | null): string | null {
	return head ? head.slice(0, 8) : null;
}

function pathContains(parentPath: string, path: string): boolean {
	return path === parentPath || path.startsWith(`${parentPath}${sep}`);
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
