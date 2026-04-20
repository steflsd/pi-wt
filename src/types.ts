export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

export interface WorktreeInfo {
	path: string;
	branch: string | null;
	head: string | null;
	detached: boolean;
	locked: string | null;
	prunable: string | null;
	isCurrent: boolean;
	isMainCheckout: boolean;
}

export interface BranchInfo {
	name: string;
	isCurrent: boolean;
	isDefault: boolean;
	worktreePath: string | null;
}

export interface RepoState {
	cwd: string;
	repoRoot: string;
	mainCheckoutPath: string;
	currentBranch: string | null;
	defaultBranch: string | null;
	worktrees: WorktreeInfo[];
	branches: BranchInfo[];
}

export interface WorkspaceTarget {
	cwd: string;
	branch: string | null;
	kind: "current" | "main" | "worktree";
}

export interface WorkspaceMenuChoice {
	type: "workspace" | "create-worktree" | "archive-worktree" | "land-worktree";
	workspace?: WorkspaceTarget;
	worktreePath?: string;
}

export interface SetupStep {
	label: string;
	command: string;
}

export interface BaseBranchSelection {
	name: string;
	ref: string;
	source: string;
}

export interface PullRequestInfo {
	number: number;
	title: string;
	url: string;
	state: string;
	isDraft: boolean;
	baseRefName: string;
	headRefName: string;
	headRefOid?: string;
}

export interface BranchPublishPlan {
	remote: string | null;
	upstream: string | null;
	needsPush: boolean;
	reason: string | null;
	commandArgs: string[] | null;
}

export interface PullRequestDraft {
	title: string;
	body: string;
	promptPath: string;
}

export interface WorktreeTemplate {
	name: string;
	prefix: string;
	base?: string;
}

export interface WorktreeProjectSettings {
	templates: WorktreeTemplate[];
	branchPickerLimit: number;
	archiveAfterLand: boolean;
	editorCommand: string | null;
	terminalCommand: string | null;
	newWorktreeTabCommand: string | null;
}

export interface CommitDraft {
	title: string;
	body: string;
	promptPath: string;
}

export type WtCommand =
	| { kind: "workspace" }
	| { kind: "status" }
	| { kind: "land" }
	| { kind: "rebase"; explicitBase?: string }
	| { kind: "pr"; explicitBase?: string }
	| { kind: "editor" }
	| { kind: "terminal" }
	| { kind: "help" };

export const WORKTREE_ROOT_FLAG = "wt-root";
export const WT_SETUP_FLAG = "wt-setup";
export const WORKTREE_CONFIG_DIR = ".pi/wt";
export const WORKTREE_SETUP_SCRIPT = ".pi/wt/setup.sh";
export const DEFAULT_WORKTREE_ROOT = "../worktrees";
export const WT_STATE_STATUS_KEY = "pi-wt-state";
