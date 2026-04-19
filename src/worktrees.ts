import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { exec, execShell, normalizeBranchName, writeGitConfig } from "./git.js";
import { safeRealpath, toErrorMessage } from "./shared.js";
import {
	type BranchInfo,
	DEFAULT_WORKTREE_ROOT,
	LEGACY_WORKTREE_SETUP_SCRIPT,
	type RepoState,
	type SetupStep,
	WORKTREE_ROOT_FLAG,
	WORKTREE_SETUP_SCRIPT,
	type WorkspaceMenuChoice,
	type WorkspaceTarget,
	type WorktreeInfo,
	type WorktreeProjectSettings,
	type WorktreeTemplate,
	WT_SETUP_FLAG,
} from "./types.js";

const DEFAULT_BASE_BRANCH_PICKER_LIMIT = 12;
const OTHER_BASE_BRANCH_LABEL = "Other branch…\n  type an existing local branch name";

export function getConfiguredWorktreeRoot(pi: ExtensionAPI): string {
	const configured = pi.getFlag(WORKTREE_ROOT_FLAG);
	return typeof configured === "string" && configured.trim().length > 0 ? configured.trim() : DEFAULT_WORKTREE_ROOT;
}

export function getConfiguredSetupStep(pi: ExtensionAPI, repo: RepoState): SetupStep | null {
	for (const scriptPath of [WORKTREE_SETUP_SCRIPT, LEGACY_WORKTREE_SETUP_SCRIPT]) {
		const projectScriptPath = join(repo.mainCheckoutPath, scriptPath);
		if (existsSync(projectScriptPath)) {
			return {
				label: projectScriptPath,
				command: `bash ${quoteShellArg(`./${scriptPath}`)}`,
			};
		}
	}

	const configured = pi.getFlag(WT_SETUP_FLAG);
	if (typeof configured !== "string") return null;
	const command = configured.trim();
	return command.length > 0 ? { label: command, command } : null;
}

export async function chooseWorkspaceTarget(
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

	const createLabel = "Create new worktree…";
	choices.set(createLabel, { type: "create-worktree" });
	options.push(createLabel);

	for (const worktree of existingWorktrees) {
		const workspace: WorkspaceTarget = {
			cwd: worktree.path,
			branch: worktree.branch,
			kind: "worktree",
		};
		const label = formatWorkspaceOption(worktree, resolvedWorktreeRoot);
		choices.set(label, { type: "workspace", workspace });
		options.push(label);
	}

	const selected = await ctx.ui.select(`Create or pick a worktree under ${resolvedWorktreeRoot}`, options);
	return selected ? choices.get(selected) : undefined;
}

export async function createWorktreeFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repo: RepoState,
	worktreeRoot: string,
	setupStep: SetupStep | null,
	templates: WorktreeTemplate[],
	branchPickerLimit = DEFAULT_BASE_BRANCH_PICKER_LIMIT,
): Promise<WorkspaceTarget | undefined> {
	const template = await chooseWorktreeTemplate(ctx, templates);
	if (template === null) {
		ctx.ui.notify("Cancelled", "info");
		return undefined;
	}

	const baseBranch = await chooseBaseBranch(ctx, repo.branches, branchPickerLimit, template?.base);
	if (!baseBranch) {
		ctx.ui.notify("Cancelled", "info");
		return undefined;
	}

	const newBranchName = await promptForNewBranchName(ctx, repo, baseBranch.name, template?.prefix);
	if (!newBranchName) {
		return undefined;
	}

	const targetPath = defaultWorktreePath(repo.mainCheckoutPath, worktreeRoot, newBranchName);
	const confirmationLines = [`Base branch: ${baseBranch.name}`, `New branch: ${newBranchName}`, `Path: ${targetPath}`];
	if (template) {
		confirmationLines.unshift(`Template: ${template.name}`);
	}
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

	await writeGitConfig(pi, targetPath, `branch.${newBranchName}.wt-parent`, baseBranch.name);

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

async function chooseWorktreeTemplate(
	ctx: ExtensionCommandContext,
	templates: WorktreeTemplate[],
): Promise<WorktreeTemplate | undefined | null> {
	if (templates.length === 0) return undefined;

	const customLabel = "Custom…\n  pick any base branch and branch name";
	const labels = [customLabel, ...templates.map((template) => formatWorktreeTemplateOption(template))];
	const byLabel = new Map<string, WorktreeTemplate | undefined>([[customLabel, undefined]]);
	for (const template of templates) {
		byLabel.set(formatWorktreeTemplateOption(template), template);
	}
	const selected = await ctx.ui.select("Optional worktree template", labels);
	if (!selected) return null;
	return byLabel.get(selected);
}

async function chooseBaseBranch(
	ctx: ExtensionCommandContext,
	branches: BranchInfo[],
	branchPickerLimit: number,
	preferredBranchName?: string,
): Promise<BranchInfo | undefined> {
	const preferred = preferredBranchName
		? branches.find((branch) => branch.name === normalizeBranchName(preferredBranchName))
		: undefined;
	if (preferred) {
		return preferred;
	}

	const recentBranches = branches.slice(0, Math.max(1, branchPickerLimit));
	const labels = recentBranches.map((branch) => formatBaseBranchOption(branch));
	const byLabel = new Map(labels.map((label, index) => [label, recentBranches[index]]));
	const hasMoreBranches = branches.length > recentBranches.length;
	if (hasMoreBranches) {
		labels.push(OTHER_BASE_BRANCH_LABEL);
	}

	const selected = await ctx.ui.select("Choose base branch", labels);
	if (!selected) {
		return undefined;
	}
	if (selected === OTHER_BASE_BRANCH_LABEL) {
		return promptForExistingBaseBranch(ctx, branches);
	}
	return byLabel.get(selected);
}

async function promptForExistingBaseBranch(
	ctx: ExtensionCommandContext,
	branches: BranchInfo[],
): Promise<BranchInfo | undefined> {
	const placeholder = branches.find((branch) => branch.isDefault)?.name ?? branches[0]?.name ?? "main";
	while (true) {
		const entered = await ctx.ui.input("Base branch name", placeholder);
		if (entered === undefined) {
			return undefined;
		}

		const branchName = normalizeBranchName(entered.trim());
		if (!branchName) {
			ctx.ui.notify("Base branch is required", "warning");
			continue;
		}

		const branch = branches.find((candidate) => candidate.name === branchName);
		if (!branch) {
			ctx.ui.notify(`Unknown local branch: ${branchName}`, "warning");
			continue;
		}

		return branch;
	}
}

async function promptForNewBranchName(
	ctx: ExtensionCommandContext,
	repo: RepoState,
	baseBranchName: string,
	prefix?: string,
): Promise<string | undefined> {
	const placeholder = prefix ? `${prefix}my-task` : "feature/my-task";
	while (true) {
		const entered = await ctx.ui.input(`New branch name (base: ${baseBranchName})`, placeholder);
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

export function readProjectWorktreeSettings(repo: RepoState): WorktreeProjectSettings {
	const settingsPath = join(repo.mainCheckoutPath, ".pi", "settings.json");
	if (!existsSync(settingsPath)) {
		return {
			templates: [],
			branchPickerLimit: DEFAULT_BASE_BRANCH_PICKER_LIMIT,
			editorCommand: null,
			terminalCommand: null,
		};
	}

	try {
		const raw = readFileSync(settingsPath, "utf8");
		const parsed = JSON.parse(raw) as {
			wt?: {
				templates?: Array<{ name?: unknown; prefix?: unknown; base?: unknown }>;
				branchPickerLimit?: unknown;
				baseBranchPickerLimit?: unknown;
				editorCommand?: unknown;
				terminalCommand?: unknown;
			};
		};
		const wtSettings = parsed?.wt;
		const templates = Array.isArray(wtSettings?.templates)
			? wtSettings.templates.flatMap((template) => {
					if (!template || typeof template !== "object") return [];
					const name = typeof template.name === "string" ? template.name.trim() : "";
					const prefix = typeof template.prefix === "string" ? template.prefix.trim() : "";
					const base = typeof template.base === "string" ? template.base.trim() : undefined;
					if (!name || !prefix) return [];
					return [{ name, prefix, ...(base ? { base } : {}) } satisfies WorktreeTemplate];
				})
			: [];
		const configuredBranchPickerLimit =
			typeof wtSettings?.branchPickerLimit === "number"
				? wtSettings.branchPickerLimit
				: wtSettings?.baseBranchPickerLimit;
		const branchPickerLimit =
			typeof configuredBranchPickerLimit === "number" &&
			Number.isInteger(configuredBranchPickerLimit) &&
			configuredBranchPickerLimit > 0
				? configuredBranchPickerLimit
				: DEFAULT_BASE_BRANCH_PICKER_LIMIT;
		const editorCommand =
			typeof wtSettings?.editorCommand === "string" && wtSettings.editorCommand.trim().length > 0
				? wtSettings.editorCommand.trim()
				: null;
		const terminalCommand =
			typeof wtSettings?.terminalCommand === "string" && wtSettings.terminalCommand.trim().length > 0
				? wtSettings.terminalCommand.trim()
				: null;
		return { templates, branchPickerLimit, editorCommand, terminalCommand };
	} catch {
		return {
			templates: [],
			branchPickerLimit: DEFAULT_BASE_BRANCH_PICKER_LIMIT,
			editorCommand: null,
			terminalCommand: null,
		};
	}
}

export function readProjectWorktreeTemplates(repo: RepoState): WorktreeTemplate[] {
	return readProjectWorktreeSettings(repo).templates;
}

export function describeCurrentWorkspace(worktree: WorktreeInfo | undefined): string {
	if (!worktree) return "(unknown)";
	if (worktree.isMainCheckout) return `main checkout (${workspaceBranchLabel(worktree)})`;
	return `linked worktree (${workspaceBranchLabel(worktree)})`;
}

export function workspaceSummary(workspace: WorkspaceTarget): string {
	const prefix = workspace.kind === "current" ? "current" : workspace.kind === "main" ? "main" : "worktree";
	const branch = workspace.branch ?? basename(workspace.cwd);
	return `${prefix} · ${branch}`;
}

function formatWorkspaceOption(worktree: WorktreeInfo, worktreeRoot?: string): string {
	const title = worktree.isCurrent
		? `Current checkout · ${workspaceBranchLabel(worktree)}`
		: worktree.isMainCheckout
			? `Main checkout · ${workspaceBranchLabel(worktree)}`
			: workspaceBranchLabel(worktree);

	const flags = [
		worktree.isCurrent && worktree.isMainCheckout ? "main" : "",
		worktree.detached ? "detached" : "",
		worktree.locked ? "locked" : "",
		worktree.prunable ? "prunable" : "",
	].filter(Boolean);

	const meta = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
	const pathLabel =
		worktreeRoot && isSubpathOf(worktree.path, worktreeRoot)
			? relative(worktreeRoot, worktree.path) || basename(worktree.path)
			: worktree.path;
	return `${title}${meta}${pathLabel ? ` · ${pathLabel}` : ""}`;
}

function formatWorktreeTemplateOption(template: WorktreeTemplate): string {
	const details = [template.prefix, template.base ? `base ${template.base}` : "custom base"]
		.filter(Boolean)
		.join(" · ");
	return `${template.name}\n  ${details}`;
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

function workspaceBranchLabel(worktree: WorktreeInfo): string {
	return worktree.branch ?? shortHead(worktree.head) ?? basename(worktree.path);
}

function shortHead(head: string | null): string | null {
	return head ? head.slice(0, 8) : null;
}

function defaultWorktreePath(mainCheckoutPath: string, worktreeRoot: string, branch: string): string {
	return join(repoWorktreeRoot(mainCheckoutPath, worktreeRoot), sanitizeBranchForPath(branch));
}

function repoWorktreeRoot(mainCheckoutPath: string, worktreeRoot: string): string {
	return join(resolveWorktreeRoot(mainCheckoutPath, worktreeRoot), basename(mainCheckoutPath));
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

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
