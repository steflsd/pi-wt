import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, matchesKey, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import {
	exec,
	execShell,
	isBranchMergedInto,
	normalizeBranchName,
	readGitConfig,
	readWorktreeChanges,
	unsetGitConfig,
	writeGitConfig,
} from "./git.js";
import { switchToLatestOrCreateSession } from "./sessions.js";
import { safeRealpath, toErrorMessage } from "./shared.js";
import {
	type BranchInfo,
	DEFAULT_WORKTREE_ROOT,
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

interface ArchiveCandidate {
	worktree: WorktreeInfo;
	pathLabel: string;
	changes: string[];
	deleteBranch: boolean;
	mergeTarget: string | null;
	mergeState: "merged" | "not-merged" | "unknown";
}

interface WorkspacePickerItem {
	choice: WorkspaceMenuChoice;
	selectItem: SelectItem;
}

interface CreateWorktreeModeSelection {
	mode: "clean" | "move-current-changes";
	changeCount: number;
}

interface StashedWorktreeChanges {
	oid: string;
	changeCount: number;
}

export function getConfiguredWorktreeRoot(pi: ExtensionAPI): string {
	const configured = pi.getFlag(WORKTREE_ROOT_FLAG);
	return typeof configured === "string" && configured.trim().length > 0 ? configured.trim() : DEFAULT_WORKTREE_ROOT;
}

export function getConfiguredSetupStep(pi: ExtensionAPI, repo: RepoState): SetupStep | null {
	const projectScriptPath = join(repo.mainCheckoutPath, WORKTREE_SETUP_SCRIPT);
	if (existsSync(projectScriptPath)) {
		return {
			label: projectScriptPath,
			command: `bash ${quoteShellArg(projectScriptPath)}`,
		};
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
	const resolvedWorktreeRoot = resolveWorktreeRoot(repo.mainCheckoutPath, worktreeRoot);
	const existingWorktrees = repo.worktrees.filter(
		(worktree) => !worktree.isMainCheckout && isSubpathOf(worktree.path, resolvedWorktreeRoot),
	);
	const items: WorkspacePickerItem[] = [
		{
			choice: { type: "create-worktree" },
			selectItem: {
				value: "create-worktree",
				label: "Create new worktree…",
				description: relative(repo.mainCheckoutPath, resolvedWorktreeRoot) || resolvedWorktreeRoot,
			},
		},
		...existingWorktrees.map((worktree) => {
			const workspace: WorkspaceTarget = {
				cwd: worktree.path,
				branch: worktree.branch,
				kind: "worktree",
			};
			return {
				choice: { type: "workspace", workspace },
				selectItem: {
					value: `worktree:${worktree.path}`,
					label: workspaceBranchLabel(worktree),
					description: formatWorkspaceDescription(worktree, resolvedWorktreeRoot),
				},
			} satisfies WorkspacePickerItem;
		}),
	];
	const itemsByValue = new Map(items.map((item) => [item.selectItem.value, item]));

	return ctx.ui.custom<WorkspaceMenuChoice | undefined>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Worktrees")), 1, 0));
		container.addChild(new Text(theme.fg("muted", resolvedWorktreeRoot), 1, 0));
		const selectList = new SelectList(
			items.map((item) => item.selectItem),
			Math.min(Math.max(items.length, 1), 10),
			{
				selectedPrefix: (text: string) => theme.fg("accent", text),
				selectedText: (text: string) => theme.fg("accent", text),
				description: (text: string) => theme.fg("muted", text),
				scrollInfo: (text: string) => theme.fg("dim", text),
				noMatch: (text: string) => theme.fg("warning", text),
			},
		);
		selectList.onSelect = (item) => done(itemsByValue.get(item.value)?.choice);
		selectList.onCancel = () => done(undefined);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate  enter select  a archive  esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (isArchiveKey(data)) {
					const selected = selectList.getSelectedItem();
					const item = selected ? itemsByValue.get(selected.value) : undefined;
					if (item?.choice.type === "workspace" && item.choice.workspace) {
						done({ type: "archive-worktree", worktreePath: item.choice.workspace.cwd });
					}
					return;
				}
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
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

	const createMode = await chooseCreateWorktreeMode(pi, ctx, repo, baseBranch.name);
	if (!createMode) {
		ctx.ui.notify("Cancelled", "info");
		return undefined;
	}

	const newBranchName = await promptForNewBranchName(ctx, repo, baseBranch.name, template?.prefix);
	if (!newBranchName) {
		return undefined;
	}

	const targetPath = defaultWorktreePath(repo.mainCheckoutPath, worktreeRoot, newBranchName);
	const confirmationLines = [`Base branch: ${baseBranch.name}`, `New branch: ${newBranchName}`, `Path: ${targetPath}`];
	if (createMode.mode === "move-current-changes") {
		confirmationLines.push(`Local changes: move ${createMode.changeCount} change(s) into the new worktree`);
	}
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

	let stashedChanges: StashedWorktreeChanges | null = null;
	let createdWorktree = false;
	let restoreStashToSource = false;
	try {
		if (createMode.mode === "move-current-changes") {
			ctx.ui.setStatus("pi-wt", `Stashing ${createMode.changeCount} local change(s)...`);
			try {
				stashedChanges = await stashCurrentChangesForNewWorktree(pi, repo.cwd, createMode.changeCount);
				restoreStashToSource = true;
			} finally {
				ctx.ui.setStatus("pi-wt", undefined);
			}
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
		createdWorktree = true;

		await writeGitConfig(pi, targetPath, `branch.${newBranchName}.wt-parent`, baseBranch.name);

		if (stashedChanges) {
			ctx.ui.setStatus("pi-wt", `Applying moved changes in ${newBranchName}...`);
			try {
				const applied = await exec(pi, "git", ["stash", "apply", "--index", stashedChanges.oid], targetPath);
				if (applied.code !== 0) {
					throw new Error(
						applied.stderr.trim() || applied.stdout.trim() || `Failed to apply moved changes in ${targetPath}`,
					);
				}
			} finally {
				ctx.ui.setStatus("pi-wt", undefined);
			}
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

		if (stashedChanges) {
			restoreStashToSource = false;
			const dropped = await dropStashByOid(pi, repo.mainCheckoutPath, stashedChanges.oid);
			if (!dropped) {
				ctx.ui.notify(
					`Moved ${stashedChanges.changeCount} local change(s) into ${newBranchName}, but left the stash entry behind.`,
					"warning",
				);
			}
		}
	} catch (error) {
		const rollbackIssues: string[] = [];
		const rollbackNotes: string[] = [];

		if (createdWorktree) {
			ctx.ui.setStatus("pi-wt", `Rolling back failed worktree creation for ${newBranchName}...`);
			try {
				const worktreeRollbackIssues = await rollbackCreatedWorktree(
					pi,
					repo.mainCheckoutPath,
					targetPath,
					newBranchName,
				);
				if (worktreeRollbackIssues.length === 0) {
					rollbackNotes.push(`removed ${newBranchName} worktree + branch`);
				} else {
					rollbackIssues.push(...worktreeRollbackIssues);
				}
			} finally {
				ctx.ui.setStatus("pi-wt", undefined);
			}
		}

		if (stashedChanges && restoreStashToSource) {
			ctx.ui.setStatus("pi-wt", "Restoring moved changes...");
			try {
				const restored = await exec(pi, "git", ["stash", "apply", "--index", stashedChanges.oid], repo.cwd);
				if (restored.code === 0) {
					rollbackNotes.push(`restored original local changes in ${repo.cwd}`);
					const dropped = await dropStashByOid(pi, repo.mainCheckoutPath, stashedChanges.oid);
					if (!dropped) {
						ctx.ui.notify("Restored local changes, but left the stash entry behind.", "warning");
					}
				} else {
					rollbackIssues.push(
						`failed to restore the stashed changes in ${repo.cwd}: ${
							restored.stderr.trim() || restored.stdout.trim() || "unknown git stash apply error"
						}`,
					);
				}
			} finally {
				ctx.ui.setStatus("pi-wt", undefined);
			}
		}

		if (rollbackIssues.length > 0) {
			const rollbackSummary = rollbackNotes.length > 0 ? `\nSucceeded:\n- ${rollbackNotes.join("\n- ")}` : "";
			throw new Error(
				`${toErrorMessage(error)}\n\nRollback incomplete:${rollbackSummary}\nFailed:\n- ${rollbackIssues.join("\n- ")}`,
			);
		}
		if (rollbackNotes.length > 0) {
			throw new Error(`${toErrorMessage(error)}\n\nRollback succeeded:\n- ${rollbackNotes.join("\n- ")}`);
		}
		throw error;
	}

	return {
		cwd: safeRealpath(targetPath),
		branch: newBranchName,
		kind: "worktree",
	};
}

export async function archiveWorktreeAtPathFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repo: RepoState,
	worktreeRoot: string,
	worktreePath: string,
): Promise<boolean> {
	const resolvedWorktreeRoot = resolveWorktreeRoot(repo.mainCheckoutPath, worktreeRoot);
	const candidates = await listArchiveCandidates(pi, repo, resolvedWorktreeRoot);
	const candidate = candidates.find((entry) => entry.worktree.path === safeRealpath(worktreePath));
	if (!candidate) {
		ctx.ui.notify(`Could not find an archivable linked worktree at ${worktreePath}.`, "warning");
		return false;
	}
	return archiveWorktreeCandidateFlow(pi, ctx, repo, candidate);
}

async function archiveWorktreeCandidateFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repo: RepoState,
	candidate: ArchiveCandidate,
): Promise<boolean> {
	if (candidate.changes.length > 0) {
		ctx.ui.notify(
			[
				`Refusing to archive ${workspaceBranchLabel(candidate.worktree)} because it has local changes (${candidate.changes.length}).`,
				`Clean ${candidate.worktree.path} first, then try /wt again.`,
			].join("\n"),
			"warning",
		);
		return false;
	}

	const switchPlan = candidate.worktree.isCurrent ? resolveArchiveSwitchPlan(repo, candidate) : null;
	if (candidate.worktree.isCurrent && !switchPlan) {
		ctx.ui.notify(
			candidate.mergeTarget
				? `Could not switch away to the base branch ${candidate.mergeTarget} before archiving ${candidate.worktree.path}.`
				: `Could not determine a base branch for ${candidate.worktree.path}.`,
			"error",
		);
		return false;
	}
	if (switchPlan?.requiresCheckout) {
		const destinationChanges = await readWorktreeChanges(pi, switchPlan.workspace.cwd, true);
		if (destinationChanges.length > 0) {
			ctx.ui.notify(
				[
					`Refusing to check out the base branch ${switchPlan.baseBranch} in ${switchPlan.workspace.cwd} because it has local changes (${destinationChanges.length}).`,
					`Clean ${switchPlan.workspace.cwd} first, then try /wt again.`,
				].join("\n"),
				"warning",
			);
			return false;
		}
	}

	const confirmationLines = [
		`Branch: ${candidate.worktree.branch ?? "(detached HEAD)"}`,
		`Path: ${candidate.worktree.path}`,
		`Delete local branch: ${describeArchiveBranchAction(candidate)}`,
		...(switchPlan ? [`Base branch: ${switchPlan.baseBranch}`] : []),
		"This removes the linked worktree directory.",
	];
	const confirmed = await ctx.ui.confirm("Archive worktree", confirmationLines.join("\n"));
	if (!confirmed) {
		return false;
	}

	if (switchPlan) {
		ctx.ui.setStatus("pi-wt", "Switching away before archiving...");
		const switched = await switchToLatestOrCreateSession(ctx, switchPlan.workspace);
		if (switched.cancelled) {
			ctx.ui.setStatus("pi-wt", undefined);
			return false;
		}
		if (switchPlan.requiresCheckout) {
			ctx.ui.setStatus("pi-wt", `Checking out base branch ${switchPlan.baseBranch}...`);
			const checkedOut = await exec(pi, "git", ["checkout", switchPlan.baseBranch], switchPlan.workspace.cwd);
			if (checkedOut.code !== 0) {
				ctx.ui.notify(
					[
						`Switched away, but could not check out base branch ${switchPlan.baseBranch}.`,
						checkedOut.stderr.trim() ||
							checkedOut.stdout.trim() ||
							`git checkout ${switchPlan.baseBranch} failed`,
					].join("\n"),
					"error",
				);
				ctx.ui.setStatus("pi-wt", undefined);
				return false;
			}
		}
	}

	ctx.ui.setStatus("pi-wt", `Archiving ${workspaceBranchLabel(candidate.worktree)}...`);
	try {
		const removed = await exec(pi, "git", ["worktree", "remove", candidate.worktree.path], repo.mainCheckoutPath);
		if (removed.code !== 0) {
			throw new Error(removed.stderr.trim() || `Failed to remove worktree ${candidate.worktree.path}`);
		}

		if (candidate.deleteBranch && candidate.worktree.branch) {
			const deleted = await exec(pi, "git", ["branch", "-d", candidate.worktree.branch], repo.mainCheckoutPath);
			if (deleted.code !== 0) {
				ctx.ui.notify(
					[
						`Removed worktree ${candidate.worktree.path}, but could not delete local branch ${candidate.worktree.branch}.`,
						deleted.stderr.trim() || deleted.stdout.trim() || "git branch -d failed",
					].join("\n"),
					"warning",
				);
				return true;
			}
		}

		ctx.ui.notify(
			candidate.deleteBranch && candidate.worktree.branch
				? `Archived ${candidate.worktree.branch}: removed worktree and deleted the local branch.`
				: `Archived ${workspaceBranchLabel(candidate.worktree)}: removed the worktree.`,
			"info",
		);
		return true;
	} finally {
		ctx.ui.setStatus("pi-wt", undefined);
	}
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

async function chooseCreateWorktreeMode(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repo: RepoState,
	baseBranchName: string,
): Promise<CreateWorktreeModeSelection | undefined> {
	if (!repo.currentBranch || normalizeBranchName(repo.currentBranch) !== normalizeBranchName(baseBranchName)) {
		return { mode: "clean", changeCount: 0 };
	}

	const currentChanges = await readWorktreeChanges(pi, repo.cwd, true);
	if (currentChanges.length === 0) {
		return { mode: "clean", changeCount: 0 };
	}

	const cleanLabel = `Create clean worktree\n  leave ${currentChanges.length} local change(s) in ${repo.currentBranch}`;
	const moveLabel = `Move current changes into new worktree\n  stash and re-apply ${currentChanges.length} local change(s), including untracked files`;
	const selected = await ctx.ui.select(`Create from ${baseBranchName}`, [cleanLabel, moveLabel]);
	if (!selected) {
		return undefined;
	}

	return {
		mode: selected === moveLabel ? "move-current-changes" : "clean",
		changeCount: currentChanges.length,
	};
}

async function rollbackCreatedWorktree(
	pi: ExtensionAPI,
	mainCheckoutPath: string,
	targetPath: string,
	branchName: string,
): Promise<string[]> {
	const issues: string[] = [];
	const removed = await exec(pi, "git", ["worktree", "remove", "--force", targetPath], mainCheckoutPath);
	if (removed.code !== 0) {
		issues.push(removed.stderr.trim() || removed.stdout.trim() || `failed to remove worktree ${targetPath}`);
		return issues;
	}

	const deletedBranch = await exec(pi, "git", ["branch", "-D", branchName], mainCheckoutPath);
	if (deletedBranch.code !== 0) {
		issues.push(
			deletedBranch.stderr.trim() || deletedBranch.stdout.trim() || `failed to delete branch ${branchName}`,
		);
		return issues;
	}

	const removedConfig = await unsetGitConfig(pi, mainCheckoutPath, `branch.${branchName}.wt-parent`);
	if (!removedConfig) {
		issues.push(`failed to remove git config branch.${branchName}.wt-parent`);
	}

	return issues;
}

async function stashCurrentChangesForNewWorktree(
	pi: ExtensionAPI,
	cwd: string,
	changeCount: number,
): Promise<StashedWorktreeChanges> {
	const before = await readStashHeadOid(pi, cwd);
	const message = `pi-wt move current changes ${Date.now()}`;
	const stashed = await exec(pi, "git", ["stash", "push", "-u", "-m", message], cwd);
	if (stashed.code !== 0) {
		throw new Error(stashed.stderr.trim() || stashed.stdout.trim() || "Failed to stash local changes");
	}

	const after = await readStashHeadOid(pi, cwd);
	if (!after || after === before) {
		throw new Error("Stashed local changes, but could not resolve the created stash entry");
	}

	return { oid: after, changeCount };
}

async function readStashHeadOid(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const result = await exec(pi, "git", ["rev-parse", "--verify", "--quiet", "refs/stash"], cwd);
	const value = result.stdout.trim();
	return result.code === 0 && value ? value : null;
}

async function dropStashByOid(pi: ExtensionAPI, cwd: string, oid: string): Promise<boolean> {
	const stashList = await exec(pi, "git", ["stash", "list", "--format=%gd%x09%H"], cwd);
	if (stashList.code !== 0) {
		return false;
	}

	const stashRef = stashList.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.split("\t"))
		.find(([, entryOid]) => entryOid === oid)?.[0];
	if (!stashRef) {
		return false;
	}

	const dropped = await exec(pi, "git", ["stash", "drop", stashRef], cwd);
	return dropped.code === 0;
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
			newWorktreeTabCommand: null,
		};
	}

	try {
		const raw = readFileSync(settingsPath, "utf8");
		const parsed = JSON.parse(raw) as {
			wt?: {
				templates?: Array<{ name?: unknown; prefix?: unknown; base?: unknown }>;
				branchPickerLimit?: unknown;
				editorCommand?: unknown;
				terminalCommand?: unknown;
				newWorktreeTabCommand?: unknown;
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
		const branchPickerLimit =
			typeof wtSettings?.branchPickerLimit === "number" &&
			Number.isInteger(wtSettings.branchPickerLimit) &&
			wtSettings.branchPickerLimit > 0
				? wtSettings.branchPickerLimit
				: DEFAULT_BASE_BRANCH_PICKER_LIMIT;
		const editorCommand =
			typeof wtSettings?.editorCommand === "string" && wtSettings.editorCommand.trim().length > 0
				? wtSettings.editorCommand.trim()
				: null;
		const terminalCommand =
			typeof wtSettings?.terminalCommand === "string" && wtSettings.terminalCommand.trim().length > 0
				? wtSettings.terminalCommand.trim()
				: null;
		const newWorktreeTabCommand =
			typeof wtSettings?.newWorktreeTabCommand === "string" && wtSettings.newWorktreeTabCommand.trim().length > 0
				? wtSettings.newWorktreeTabCommand.trim()
				: null;
		return { templates, branchPickerLimit, editorCommand, terminalCommand, newWorktreeTabCommand };
	} catch {
		return {
			templates: [],
			branchPickerLimit: DEFAULT_BASE_BRANCH_PICKER_LIMIT,
			editorCommand: null,
			terminalCommand: null,
			newWorktreeTabCommand: null,
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

function resolveArchiveSwitchPlan(
	repo: RepoState,
	candidate: ArchiveCandidate,
): { workspace: WorkspaceTarget; baseBranch: string; requiresCheckout: boolean } | null {
	const baseBranch = candidate.mergeTarget;
	if (!baseBranch) {
		return null;
	}

	const normalizedBaseBranch = normalizeBranchName(baseBranch);
	const matchingCheckout = repo.worktrees.find(
		(worktree) =>
			!worktree.isCurrent && worktree.branch && normalizeBranchName(worktree.branch) === normalizedBaseBranch,
	);
	if (matchingCheckout) {
		return {
			workspace: {
				cwd: matchingCheckout.path,
				branch: matchingCheckout.branch,
				kind: matchingCheckout.isMainCheckout ? "main" : "worktree",
			},
			baseBranch: normalizedBaseBranch,
			requiresCheckout: false,
		};
	}

	const primaryCheckout = repo.worktrees.find((worktree) => worktree.isMainCheckout && !worktree.isCurrent);
	if (!primaryCheckout) {
		return null;
	}

	return {
		workspace: {
			cwd: primaryCheckout.path,
			branch: primaryCheckout.branch,
			kind: "main",
		},
		baseBranch: normalizedBaseBranch,
		requiresCheckout: normalizeBranchName(primaryCheckout.branch ?? "") !== normalizedBaseBranch,
	};
}

async function listArchiveCandidates(
	pi: ExtensionAPI,
	repo: RepoState,
	resolvedWorktreeRoot: string,
): Promise<ArchiveCandidate[]> {
	const worktrees = repo.worktrees.filter(
		(worktree) => !worktree.isMainCheckout && isSubpathOf(worktree.path, resolvedWorktreeRoot),
	);

	return Promise.all(
		worktrees.map(async (worktree) => {
			const branch = worktree.branch;
			const configuredTarget = branch
				? await readGitConfig(pi, repo.mainCheckoutPath, `branch.${branch}.wt-parent`)
				: null;
			const mergeTarget = branch ? (configuredTarget ?? repo.defaultBranch) : null;
			const mergeState =
				branch && mergeTarget && normalizeBranchName(branch) !== normalizeBranchName(mergeTarget)
					? ((await isBranchMergedInto(pi, repo.mainCheckoutPath, branch, mergeTarget)) ?? "unknown")
					: "unknown";
			const changes = await readWorktreeChanges(pi, worktree.path, true);
			return {
				worktree,
				pathLabel: relative(resolvedWorktreeRoot, worktree.path) || basename(worktree.path),
				changes,
				deleteBranch: Boolean(branch && mergeTarget && mergeState === true),
				mergeTarget: mergeTarget ? normalizeBranchName(mergeTarget) : null,
				mergeState: mergeState === true ? "merged" : mergeState === false ? "not-merged" : "unknown",
			} satisfies ArchiveCandidate;
		}),
	);
}

function formatWorkspaceDescription(worktree: WorktreeInfo, worktreeRoot?: string): string {
	const flags = [
		worktree.isCurrent ? "current" : "",
		worktree.detached ? "detached" : "",
		worktree.locked ? "locked" : "",
		worktree.prunable ? "prunable" : "",
	].filter(Boolean);
	const pathLabel =
		worktreeRoot && isSubpathOf(worktree.path, worktreeRoot)
			? relative(worktreeRoot, worktree.path) || basename(worktree.path)
			: worktree.path;
	return [pathLabel, flags.length > 0 ? `[${flags.join(", ")}]` : ""].filter(Boolean).join(" · ");
}

function describeArchiveBranchAction(candidate: ArchiveCandidate): string {
	if (!candidate.worktree.branch) {
		return "no (detached HEAD)";
	}
	if (candidate.deleteBranch && candidate.mergeTarget) {
		return `yes (safe delete after merge into ${candidate.mergeTarget})`;
	}
	if (candidate.mergeState === "not-merged" && candidate.mergeTarget) {
		return `no (${candidate.worktree.branch} is not merged into ${candidate.mergeTarget})`;
	}
	if (candidate.mergeTarget) {
		return `no (could not verify merge into ${candidate.mergeTarget})`;
	}
	return "no (no merge target could be determined)";
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

function isArchiveKey(data: string): boolean {
	return data === "a" || data === "A" || matchesKey(data, "a") || matchesKey(data, "shift+a");
}

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
