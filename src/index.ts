import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionInfo,
	SessionManager,
} from "@mariozechner/pi-coding-agent";

interface ExecResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

interface WorktreeInfo {
	path: string;
	branch: string | null;
	head: string | null;
	detached: boolean;
	locked: string | null;
	prunable: string | null;
	isCurrent: boolean;
	isMainCheckout: boolean;
}

interface BranchInfo {
	name: string;
	isCurrent: boolean;
	isDefault: boolean;
	worktreePath: string | null;
}

interface RepoState {
	cwd: string;
	repoRoot: string;
	mainCheckoutPath: string;
	currentBranch: string | null;
	defaultBranch: string | null;
	worktrees: WorktreeInfo[];
	branches: BranchInfo[];
}

interface WorkspaceTarget {
	cwd: string;
	branch: string | null;
	kind: "current" | "main" | "worktree";
}

interface WorkspaceMenuChoice {
	type: "workspace" | "create-worktree";
	workspace?: WorkspaceTarget;
}

type SessionSelectionMode = "auto" | "pick" | "new";

const WORKTREE_ROOT_FLAG = "wt-root";
const DEFAULT_WORKTREE_ROOT = "../worktrees";

export default function (pi: ExtensionAPI) {
	pi.registerFlag(WORKTREE_ROOT_FLAG, {
		description: "Root directory for new worktrees. Relative paths are resolved from the repo's main checkout.",
		type: "string",
		default: DEFAULT_WORKTREE_ROOT,
	});

	pi.registerCommand("wt", {
		description: "Create or switch worktrees and continue the most recent session there by default",
		handler: async (args, ctx) => {
			try {
				if (!ctx.hasUI) {
					throw new Error("/wt requires a UI-capable mode");
				}
				const sessionMode = parseSessionSelectionMode(args);
				const repo = await inspectRepo(pi, ctx.cwd);
				if (!repo) {
					ctx.ui.notify("/wt must be run inside a git repository", "error");
					return;
				}

				const menuChoice = await chooseWorkspaceTarget(ctx, repo, getConfiguredWorktreeRoot(pi));
				if (!menuChoice) {
					ctx.ui.notify("Cancelled", "info");
					return;
				}

				const workspace =
					menuChoice.type === "workspace"
						? menuChoice.workspace
						: await createWorktreeFlow(pi, ctx, repo, getConfiguredWorktreeRoot(pi));
				if (!workspace) {
					return;
				}

				const sessions = await listSessions(workspace.cwd);
				if (sessionMode === "pick" && sessions.length > 0) {
					const selected = await chooseSession(ctx, workspace, sessions);
					if (!selected) {
						ctx.ui.notify("Cancelled", "info");
						return;
					}
					await ctx.waitForIdle();
					const result = await ctx.switchSession(selected.path);
					if (!result.cancelled) {
						ctx.ui.notify(`Switched to ${workspaceSummary(workspace)} · ${describeSession(selected)}`, "info");
					}
					return;
				}

				if (sessionMode !== "new" && sessions.length > 0) {
					await ctx.waitForIdle();
					const result = await ctx.switchSession(sessions[0].path);
					if (!result.cancelled) {
						ctx.ui.notify(
							`Switched to ${workspaceSummary(workspace)} · ${describeSession(sessions[0])}`,
							"info",
						);
					}
					return;
				}

				await ctx.waitForIdle();
				const sessionManager = SessionManager.create(workspace.cwd);
				const sessionFile = sessionManager.getSessionFile();
				if (!sessionFile) {
					ctx.ui.notify("Failed to prepare session file", "error");
					return;
				}
				await persistNewSessionHeader(sessionManager, sessionFile);
				const result = await ctx.switchSession(sessionFile);
				if (!result.cancelled) {
					ctx.ui.notify(`Created new session in ${workspaceSummary(workspace)}`, "info");
				}
			} catch (error) {
				const message = toErrorMessage(error);
				if (ctx.hasUI) {
					ctx.ui.notify(message, "error");
					return;
				}
				throw error instanceof Error ? error : new Error(message);
			}
		},
	});
}

async function persistNewSessionHeader(sessionManager: SessionManager, sessionFile: string): Promise<void> {
	const header = sessionManager.getHeader();
	if (!header) {
		throw new Error("Failed to initialize session header");
	}
	await writeFile(sessionFile, `${JSON.stringify(header)}\n`, "utf8");
}

function parseSessionSelectionMode(args: string): SessionSelectionMode {
	const normalized = args.trim().toLowerCase();
	if (!normalized) return "auto";
	if (["pick", "session", "sessions", "choose"].includes(normalized)) return "pick";
	if (["new", "fresh"].includes(normalized)) return "new";
	throw new Error("Usage: /wt [pick|new]");
}

function getConfiguredWorktreeRoot(pi: ExtensionAPI): string {
	const configured = pi.getFlag(WORKTREE_ROOT_FLAG);
	return typeof configured === "string" && configured.trim().length > 0 ? configured.trim() : DEFAULT_WORKTREE_ROOT;
}

async function inspectRepo(pi: ExtensionAPI, cwd: string): Promise<RepoState | null> {
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

async function chooseWorkspaceTarget(
	ctx: ExtensionCommandContext,
	repo: RepoState,
	worktreeRoot: string,
): Promise<WorkspaceMenuChoice | undefined> {
	const choices = new Map<string, WorkspaceMenuChoice>();
	const options: string[] = [];

	for (const worktree of repo.worktrees) {
		const workspace: WorkspaceTarget = {
			cwd: worktree.path,
			branch: worktree.branch,
			kind: worktree.isCurrent ? "current" : worktree.isMainCheckout ? "main" : "worktree",
		};
		const label = formatWorkspaceOption(worktree);
		choices.set(label, { type: "workspace", workspace });
		options.push(label);
	}

	const createLabel = `Create new worktree…\n  base branch + new branch under ${worktreeRoot}`;
	choices.set(createLabel, { type: "create-worktree" });
	options.push(createLabel);

	const selected = await ctx.ui.select("Pick workspace or create a new one", options);
	return selected ? choices.get(selected) : undefined;
}

async function createWorktreeFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repo: RepoState,
	worktreeRoot: string,
): Promise<WorkspaceTarget | undefined> {
	const baseBranch = await chooseBaseBranch(ctx, repo.branches);
	if (!baseBranch) {
		ctx.ui.notify("Cancelled", "info");
		return undefined;
	}

	const newBranchName = await promptForNewBranchName(ctx, repo, baseBranch.name);
	if (!newBranchName) {
		return undefined;
	}

	const defaultPath = defaultWorktreePath(repo.mainCheckoutPath, worktreeRoot, newBranchName);
	const targetPath = await promptForWorktreePath(ctx, repo.mainCheckoutPath, defaultPath);
	if (!targetPath) {
		ctx.ui.notify("Cancelled", "info");
		return undefined;
	}

	const confirmed = await ctx.ui.confirm(
		"Create worktree",
		[`Base branch: ${baseBranch.name}`, `New branch: ${newBranchName}`, `Path: ${targetPath}`].join("\n"),
	);
	if (!confirmed) {
		ctx.ui.notify("Cancelled", "info");
		return undefined;
	}

	try {
		await mkdir(dirname(targetPath), { recursive: true });
	} catch (error) {
		throw new Error(`Failed to create ${dirname(targetPath)}: ${toErrorMessage(error)}`);
	}

	const created = await exec(
		pi,
		"git",
		["worktree", "add", "-b", newBranchName, targetPath, baseBranch.name],
		repo.mainCheckoutPath,
	);
	if (created.code !== 0) {
		throw new Error(created.stderr.trim() || `Failed to create worktree ${targetPath}`);
	}

	return {
		cwd: safeRealpath(targetPath),
		branch: newBranchName,
		kind: "worktree",
	};
}

async function chooseBaseBranch(ctx: ExtensionCommandContext, branches: BranchInfo[]): Promise<BranchInfo | undefined> {
	const labels = branches.map((branch) => formatBaseBranchOption(branch));
	const byLabel = new Map(labels.map((label, index) => [label, branches[index]]));
	const selected = await ctx.ui.select("Choose base branch", labels);
	return selected ? byLabel.get(selected) : undefined;
}

async function promptForNewBranchName(
	ctx: ExtensionCommandContext,
	repo: RepoState,
	baseBranchName: string,
): Promise<string | undefined> {
	while (true) {
		const entered = await ctx.ui.input(`New branch name (base: ${baseBranchName})`, "feature/my-task");
		if (entered === undefined) {
			ctx.ui.notify("Cancelled", "info");
			return undefined;
		}

		const branchName = entered.trim();
		if (!branchName) {
			ctx.ui.notify("Branch name is required", "warning");
			continue;
		}

		if (repo.branches.some((branch) => branch.name === branchName)) {
			ctx.ui.notify(`Branch already exists: ${branchName}`, "warning");
			continue;
		}

		return branchName;
	}
}

async function promptForWorktreePath(
	ctx: ExtensionCommandContext,
	mainCheckoutPath: string,
	defaultPath: string,
): Promise<string | undefined> {
	const entered = await ctx.ui.input("Worktree path override (leave blank for default)", defaultPath);
	if (entered === undefined) {
		return undefined;
	}

	const trimmed = entered.trim();
	if (!trimmed) {
		return defaultPath;
	}

	return safeRealpath(isAbsolute(trimmed) ? trimmed : resolve(mainCheckoutPath, trimmed));
}

async function listSessions(cwd: string): Promise<SessionInfo[]> {
	try {
		return (await SessionManager.list(cwd)).sort((left, right) => right.modified.getTime() - left.modified.getTime());
	} catch (error) {
		if (isMissingFileError(error)) {
			return [];
		}
		throw error;
	}
}

async function chooseSessionAction(
	ctx: ExtensionCommandContext,
	workspace: WorkspaceTarget,
	sessions: SessionInfo[],
): Promise<
	{ type: "continue-recent"; session: SessionInfo } | { type: "pick-session" } | { type: "new-session" } | undefined
> {
	const options: string[] = [];
	if (sessions.length > 0) {
		options.push(`Continue recent · ${describeSession(sessions[0])}`);
		if (sessions.length > 1) {
			options.push(`Pick session · ${sessions.length} sessions`);
		}
	}
	options.push(`New session · ${workspaceSummary(workspace)}`);

	const selected = await ctx.ui.select(`Session for ${workspaceSummary(workspace)}`, options);
	if (!selected) return undefined;
	if (selected.startsWith("Continue recent")) {
		return { type: "continue-recent", session: sessions[0] };
	}
	if (selected.startsWith("Pick session")) {
		return { type: "pick-session" };
	}
	return { type: "new-session" };
}

async function chooseSession(
	ctx: ExtensionCommandContext,
	workspace: WorkspaceTarget,
	sessions: SessionInfo[],
): Promise<SessionInfo | undefined> {
	const labels = sessions.map((session) => `${describeSession(session)}\n  ${session.path}`);
	const byLabel = new Map(labels.map((label, index) => [label, sessions[index]]));
	const selected = await ctx.ui.select(`Pick session for ${workspaceSummary(workspace)}`, labels);
	return selected ? byLabel.get(selected) : undefined;
}

function formatWorkspaceOption(worktree: WorktreeInfo): string {
	const title = worktree.isCurrent
		? `Current checkout · ${workspaceBranchLabel(worktree)}`
		: worktree.isMainCheckout
			? `Main checkout · ${workspaceBranchLabel(worktree)}`
			: `Worktree · ${workspaceBranchLabel(worktree)}`;

	const flags = [
		worktree.isCurrent && worktree.isMainCheckout ? "main" : "",
		worktree.detached ? "detached" : "",
		worktree.locked ? "locked" : "",
		worktree.prunable ? "prunable" : "",
	].filter(Boolean);

	const meta = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
	return `${title}${meta}\n  ${worktree.path}`;
}

function formatBaseBranchOption(branch: BranchInfo): string {
	const flags = [
		branch.isCurrent ? "current" : "",
		branch.isDefault ? "default" : "",
		branch.worktreePath ? "checked out" : "",
	].filter(Boolean);
	const meta = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
	return `${branch.name}${meta}`;
}

function workspaceSummary(workspace: WorkspaceTarget): string {
	const prefix = workspace.kind === "current" ? "current" : workspace.kind === "main" ? "main" : "worktree";
	const branch = workspace.branch ?? basename(workspace.cwd);
	return `${prefix} · ${branch}`;
}

function workspaceBranchLabel(worktree: WorktreeInfo): string {
	return worktree.branch ?? shortHead(worktree.head) ?? basename(worktree.path);
}

function shortHead(head: string | null): string | null {
	return head ? head.slice(0, 8) : null;
}

function defaultWorktreePath(mainCheckoutPath: string, worktreeRoot: string, branch: string): string {
	const rootPath = isAbsolute(worktreeRoot) ? worktreeRoot : resolve(mainCheckoutPath, worktreeRoot);
	return join(rootPath, sanitizeBranchForPath(branch));
}

function sanitizeBranchForPath(branch: string): string {
	const sanitized = branch
		.trim()
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return sanitized || "worktree";
}

function describeSession(session: SessionInfo): string {
	const label = session.name?.trim() || session.firstMessage?.trim() || session.id;
	const when = session.modified.toLocaleString();
	return `${truncate(label, 80)} · ${when}`;
}

function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
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

async function exec(pi: ExtensionAPI, command: string, args: string[], cwd: string): Promise<ExecResult> {
	const result = await pi.exec(command, args, { cwd });
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		code: result.code ?? null,
	};
}

function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function isMissingFileError(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT",
	);
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
