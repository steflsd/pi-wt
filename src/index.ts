import { existsSync, realpathSync } from "node:fs";
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

interface SetupStep {
	label: string;
	command: string;
}

interface BaseBranchSelection {
	name: string;
	ref: string;
	source: string;
}

interface PullRequestInfo {
	number: number;
	title: string;
	url: string;
	state: string;
	isDraft: boolean;
	baseRefName: string;
	headRefName: string;
}

type SessionSelectionMode = "auto" | "pick" | "new";

type WtCommand =
	| { kind: "workspace"; sessionMode: SessionSelectionMode }
	| { kind: "status" }
	| { kind: "rebase"; explicitBase?: string }
	| { kind: "pr"; explicitBase?: string }
	| { kind: "help" };

const WORKTREE_ROOT_FLAG = "wt-root";
const WT_SETUP_FLAG = "wt-setup";
const WORKTREE_SETUP_SCRIPT = ".pi/wt-setup.sh";
const DEFAULT_WORKTREE_ROOT = "../worktrees";

export default function (pi: ExtensionAPI) {
	pi.registerFlag(WORKTREE_ROOT_FLAG, {
		description: "Root directory for new worktrees. Relative paths are resolved from the repo's main checkout.",
		type: "string",
		default: DEFAULT_WORKTREE_ROOT,
	});

	pi.registerFlag(WT_SETUP_FLAG, {
		description: "Optional shell command to run inside a newly created worktree before switching sessions.",
		type: "string",
		default: "",
	});

	pi.registerCommand("wt", {
		description: "Worktree helpers: switch/create worktrees, show status, rebase, and manage PRs",
		getArgumentCompletions: (prefix) => getWtArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			try {
				if (!ctx.hasUI) {
					throw new Error("/wt requires a UI-capable mode");
				}

				const command = parseWtCommand(args);
				switch (command.kind) {
					case "workspace":
						await handleWorkspaceCommand(pi, ctx, command.sessionMode);
						return;
					case "status":
						await handleStatusCommand(pi, ctx);
						return;
					case "rebase":
						await handleRebaseCommand(pi, ctx, command.explicitBase);
						return;
					case "pr":
						await handlePrCommand(pi, ctx, command.explicitBase);
						return;
					case "help":
						ctx.ui.notify(wtUsageText(), "info");
						return;
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

function getWtArgumentCompletions(prefix: string) {
	const trimmed = prefix.trimStart();
	if (trimmed.includes(" ")) return null;

	const items = [
		{ value: "pick", label: "pick a session in the selected workspace" },
		{ value: "new", label: "create a fresh session in the selected workspace" },
		{ value: "status", label: "show current worktree, branch, base branch, and PR info" },
		{ value: "rebase", label: "rebase the current branch onto its detected parent/base branch" },
		{ value: "pr", label: "view or create a PR for the current branch" },
		{ value: "help", label: "show /wt usage" },
	];

	const filtered = items.filter((item) => item.value.startsWith(trimmed));
	return filtered.length > 0 ? filtered : null;
}

function parseWtCommand(args: string): WtCommand {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "workspace", sessionMode: "auto" };

	const [subcommand, ...rest] = trimmed.split(/\s+/);
	const normalized = subcommand.toLowerCase();
	const trailing = rest.join(" ").trim();

	if (["pick", "session", "sessions", "choose"].includes(normalized)) {
		if (trailing) throw new Error("Usage: /wt pick");
		return { kind: "workspace", sessionMode: "pick" };
	}

	if (["new", "fresh"].includes(normalized)) {
		if (trailing) throw new Error("Usage: /wt new");
		return { kind: "workspace", sessionMode: "new" };
	}

	if (normalized === "status") {
		if (trailing) throw new Error("Usage: /wt status");
		return { kind: "status" };
	}

	if (normalized === "rebase") {
		return { kind: "rebase", explicitBase: trailing || undefined };
	}

	if (normalized === "pr") {
		return { kind: "pr", explicitBase: trailing || undefined };
	}

	if (normalized === "help") {
		return { kind: "help" };
	}

	throw new Error(wtUsageText());
}

function wtUsageText(): string {
	return [
		"Usage:",
		"/wt               Open the worktree picker/create flow",
		"/wt pick          Pick a session in the selected workspace",
		"/wt new           Create a fresh session in the selected workspace",
		"/wt status        Show current branch, base branch, and PR info",
		"/wt rebase [base] Rebase current branch onto detected or explicit base branch",
		"/wt pr [base]     View current PR, or create one against detected or explicit base branch",
	].join("\n");
}

async function handleWorkspaceCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	sessionMode: SessionSelectionMode,
): Promise<void> {
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
			: await createWorktreeFlow(pi, ctx, repo, getConfiguredWorktreeRoot(pi), getConfiguredSetupStep(pi, repo));
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
			ctx.ui.notify(`Switched to ${workspaceSummary(workspace)} · ${describeSession(sessions[0])}`, "info");
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
}

async function handleStatusCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const repo = await inspectRepo(pi, ctx.cwd);
	if (!repo) {
		ctx.ui.notify("/wt must be run inside a git repository", "error");
		return;
	}

	const currentWorktree = repo.worktrees.find((worktree) => worktree.isCurrent);
	const pr = await readCurrentPr(pi, repo.cwd);
	const baseBranch = repo.currentBranch ? await detectBaseBranch(pi, repo, repo.cwd, repo.currentBranch) : null;

	const lines = [
		`Repo root: ${repo.repoRoot}`,
		`Main checkout: ${repo.mainCheckoutPath}`,
		`Current cwd: ${repo.cwd}`,
		`Workspace: ${describeCurrentWorkspace(currentWorktree)}`,
		`Branch: ${repo.currentBranch ?? "(detached HEAD)"}`,
		`Default branch: ${repo.defaultBranch ?? "(unknown)"}`,
		`Detected base: ${baseBranch ? `${baseBranch.name} (${baseBranch.source})` : "(none)"}`,
		pr ? `PR: #${pr.number} ${pr.title} [${formatPrState(pr)}]\n  ${pr.url}` : "PR: (none)",
	];

	ctx.ui.notify(lines.join("\n"), "info");
}

async function handleRebaseCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	explicitBase?: string,
): Promise<void> {
	const repo = await inspectRepo(pi, ctx.cwd);
	if (!repo) {
		ctx.ui.notify("/wt must be run inside a git repository", "error");
		return;
	}
	if (!repo.currentBranch) {
		ctx.ui.notify("Cannot rebase from detached HEAD", "error");
		return;
	}

	const baseBranch = await detectBaseBranch(pi, repo, repo.cwd, repo.currentBranch, explicitBase);
	if (!baseBranch) {
		ctx.ui.notify("Could not determine a base branch. Try /wt rebase <branch>", "error");
		return;
	}
	if (normalizeBranchName(baseBranch.name) === normalizeBranchName(repo.currentBranch)) {
		ctx.ui.notify(`Refusing to rebase ${repo.currentBranch} onto itself`, "error");
		return;
	}

	const confirmed = await ctx.ui.confirm(
		"Rebase current branch",
		[
			`Current branch: ${repo.currentBranch}`,
			`Base branch: ${baseBranch.name}`,
			`Git ref: ${baseBranch.ref}`,
			`Source: ${baseBranch.source}`,
		].join("\n"),
	);
	if (!confirmed) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	await ctx.waitForIdle();
	ctx.ui.setStatus("pi-wt", `Rebasing ${repo.currentBranch} onto ${baseBranch.ref}...`);
	try {
		const result = await exec(pi, "git", ["rebase", baseBranch.ref], repo.cwd);
		if (result.code === 0) {
			const output = summarizeCommandOutput(result);
			ctx.ui.notify(
				[`Rebased ${repo.currentBranch} onto ${baseBranch.name}.`, output ? `\n${output}` : ""]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
			return;
		}

		ctx.ui.notify(
			[
				`git rebase ${baseBranch.ref} failed.`,
				summarizeCommandOutput(result) ||
					"Resolve conflicts, then run git rebase --continue or git rebase --abort.",
			].join("\n\n"),
			"error",
		);
	} finally {
		ctx.ui.setStatus("pi-wt", undefined);
	}
}

async function handlePrCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, explicitBase?: string): Promise<void> {
	const repo = await inspectRepo(pi, ctx.cwd);
	if (!repo) {
		ctx.ui.notify("/wt must be run inside a git repository", "error");
		return;
	}
	if (!repo.currentBranch) {
		ctx.ui.notify("Cannot manage a PR from detached HEAD", "error");
		return;
	}

	if (!(await hasGhCli(pi, repo.cwd))) {
		ctx.ui.notify("gh CLI is required for /wt pr", "error");
		return;
	}

	const existingPr = await readCurrentPr(pi, repo.cwd);
	if (existingPr) {
		ctx.ui.notify(
			[
				`PR #${existingPr.number}: ${existingPr.title}`,
				`State: ${formatPrState(existingPr)}`,
				`Base: ${existingPr.baseRefName}`,
				`Head: ${existingPr.headRefName}`,
				existingPr.url,
			].join("\n"),
			"info",
		);
		return;
	}

	const baseBranch = await detectBaseBranch(pi, repo, repo.cwd, repo.currentBranch, explicitBase);
	if (!baseBranch) {
		ctx.ui.notify("Could not determine a base branch. Try /wt pr <branch>", "error");
		return;
	}

	const confirmed = await ctx.ui.confirm(
		"Create PR",
		[
			`Head branch: ${repo.currentBranch}`,
			`Base branch: ${baseBranch.name}`,
			`Source: ${baseBranch.source}`,
			"Command: gh pr create --fill --base <base>",
		].join("\n"),
	);
	if (!confirmed) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	await ctx.waitForIdle();
	ctx.ui.setStatus("pi-wt", `Creating PR for ${repo.currentBranch}...`);
	try {
		const result = await exec(pi, "gh", ["pr", "create", "--fill", "--base", baseBranch.name], repo.cwd);
		if (result.code === 0) {
			ctx.ui.notify(
				[`Created PR for ${repo.currentBranch} against ${baseBranch.name}.`, summarizeCommandOutput(result)]
					.filter(Boolean)
					.join("\n\n"),
				"info",
			);
			return;
		}

		ctx.ui.notify(
			[
				`gh pr create failed for ${repo.currentBranch}.`,
				summarizeCommandOutput(result) || "Check gh auth and repository settings.",
			].join("\n\n"),
			"error",
		);
	} finally {
		ctx.ui.setStatus("pi-wt", undefined);
	}
}

async function persistNewSessionHeader(sessionManager: SessionManager, sessionFile: string): Promise<void> {
	const header = sessionManager.getHeader();
	if (!header) {
		throw new Error("Failed to initialize session header");
	}
	await writeFile(sessionFile, `${JSON.stringify(header)}\n`, "utf8");
}

function getConfiguredWorktreeRoot(pi: ExtensionAPI): string {
	const configured = pi.getFlag(WORKTREE_ROOT_FLAG);
	return typeof configured === "string" && configured.trim().length > 0 ? configured.trim() : DEFAULT_WORKTREE_ROOT;
}

function getConfiguredSetupStep(pi: ExtensionAPI, repo: RepoState): SetupStep | null {
	const projectScriptPath = join(repo.mainCheckoutPath, WORKTREE_SETUP_SCRIPT);
	if (existsSync(projectScriptPath)) {
		return {
			label: projectScriptPath,
			command: `bash ${quoteShellArg(`./${WORKTREE_SETUP_SCRIPT}`)}`,
		};
	}

	const configured = pi.getFlag(WT_SETUP_FLAG);
	if (typeof configured !== "string") return null;
	const command = configured.trim();
	return command.length > 0 ? { label: command, command } : null;
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
	const resolvedWorktreeRoot = resolveWorktreeRoot(repo.mainCheckoutPath, worktreeRoot);
	const existingWorktrees = repo.worktrees.filter(
		(worktree) => !worktree.isCurrent && !worktree.isMainCheckout && isSubpathOf(worktree.path, resolvedWorktreeRoot),
	);

	const createLabel = `Create new worktree…\n  base branch + new branch under ${resolvedWorktreeRoot}`;
	choices.set(createLabel, { type: "create-worktree" });
	options.push(createLabel);

	for (const worktree of existingWorktrees) {
		const workspace: WorkspaceTarget = {
			cwd: worktree.path,
			branch: worktree.branch,
			kind: "worktree",
		};
		const label = formatWorkspaceOption(worktree);
		choices.set(label, { type: "workspace", workspace });
		options.push(label);
	}

	const selected = await ctx.ui.select("Create a new worktree or pick an existing one", options);
	return selected ? choices.get(selected) : undefined;
}

async function createWorktreeFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repo: RepoState,
	worktreeRoot: string,
	setupStep: SetupStep | null,
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

	const targetPath = defaultWorktreePath(repo.mainCheckoutPath, worktreeRoot, newBranchName);

	const confirmationLines = [`Base branch: ${baseBranch.name}`, `New branch: ${newBranchName}`, `Path: ${targetPath}`];
	if (setupStep) {
		confirmationLines.push(`Setup: ${setupStep.label}`);
	}
	const confirmed = await ctx.ui.confirm("Create worktree", confirmationLines.join("\n"));
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

	if (setupStep) {
		ctx.ui.setStatus("pi-wt", `Running setup in ${newBranchName}...`);
		try {
			const setup = await execShell(pi, setupStep.command, targetPath);
			if (setup.code !== 0) {
				throw new Error(setup.stderr.trim() || setup.stdout.trim() || `Setup failed in ${targetPath}`);
			}
			ctx.ui.notify(`Setup finished: ${setupStep.label}`, "info");
		} finally {
			ctx.ui.setStatus("pi-wt", undefined);
		}
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

async function listSessions(cwd: string): Promise<SessionInfo[]> {
	try {
		return (await SessionManager.list(cwd))
			.filter((session) => !session.cwd || safeRealpath(session.cwd) === safeRealpath(cwd))
			.sort((left, right) => right.modified.getTime() - left.modified.getTime());
	} catch (error) {
		if (isMissingFileError(error)) {
			return [];
		}
		throw error;
	}
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

async function detectBaseBranch(
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
		return resolveBaseBranchSelection(pi, cwd, storedParent, `git config branch.${currentBranch}.wt-parent`);
	}

	const ghMergeBase = await readGitConfig(pi, cwd, `branch.${currentBranch}.gh-merge-base`);
	if (ghMergeBase) {
		return resolveBaseBranchSelection(pi, cwd, ghMergeBase, `git config branch.${currentBranch}.gh-merge-base`);
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

async function hasGhCli(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const result = await exec(pi, "gh", ["--version"], cwd);
	return result.code === 0;
}

async function readCurrentPr(pi: ExtensionAPI, cwd: string): Promise<PullRequestInfo | null> {
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

async function readGitConfig(pi: ExtensionAPI, cwd: string, key: string): Promise<string | null> {
	const result = await exec(pi, "git", ["config", "--get", key], cwd);
	const value = result.stdout.trim();
	return result.code === 0 && value ? value : null;
}

async function verifyRef(pi: ExtensionAPI, cwd: string, branchish: string): Promise<boolean> {
	const result = await exec(pi, "git", ["rev-parse", "--verify", "--quiet", branchish], cwd);
	return result.code === 0;
}

async function refExists(pi: ExtensionAPI, cwd: string, ref: string): Promise<boolean> {
	const result = await exec(pi, "git", ["show-ref", "--verify", "--quiet", ref], cwd);
	return result.code === 0;
}

function normalizeBranchName(branchish: string): string {
	return branchish
		.replace(/^refs\/heads\//, "")
		.replace(/^refs\/remotes\/origin\//, "")
		.replace(/^origin\//, "");
}

function formatPrState(pr: PullRequestInfo): string {
	return pr.isDraft ? `${pr.state} draft` : pr.state;
}

function summarizeCommandOutput(result: ExecResult): string {
	return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

function describeCurrentWorkspace(worktree: WorktreeInfo | undefined): string {
	if (!worktree) return "(unknown)";
	if (worktree.isMainCheckout) return `main checkout (${workspaceBranchLabel(worktree)})`;
	return `linked worktree (${workspaceBranchLabel(worktree)})`;
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
	return join(resolveWorktreeRoot(mainCheckoutPath, worktreeRoot), sanitizeBranchForPath(branch));
}

function resolveWorktreeRoot(mainCheckoutPath: string, worktreeRoot: string): string {
	return isAbsolute(worktreeRoot) ? worktreeRoot : resolve(mainCheckoutPath, worktreeRoot);
}

function isSubpathOf(path: string, parentPath: string): boolean {
	const normalizedPath = safeRealpath(path);
	const normalizedParent = safeRealpath(parentPath);
	return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
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

async function execShell(pi: ExtensionAPI, command: string, cwd: string): Promise<ExecResult> {
	const shell = process.env.SHELL || "bash";
	return exec(pi, shell, ["-lc", command], cwd);
}

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
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
