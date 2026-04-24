import { describe, expect, test } from "vitest";
import { buildStatusActionHints } from "../src/commands/status.js";

describe("buildStatusActionHints", () => {
	test("suggests rebase, pr, and land for a clean feature branch", () => {
		// Arrange
		const options = {
			hasBranch: true,
			isDefaultBranch: false,
			hasLinkedWorktree: true,
			hasBaseBranch: true,
			hasPullRequest: false,
			ghAvailable: true,
			localChangesCount: 0,
			trackedChangesCount: 0,
			landingReadiness: "ready" as const,
		};

		// Act
		const hints = buildStatusActionHints(options);

		// Assert
		expect(hints).toEqual([
			{ command: "/wt rebase", detail: "update this branch onto its detected base branch" },
			{ command: "/wt pr", detail: "create a PR against the detected base branch" },
			{
				command: "/wt land",
				detail: "rebase, fast-forward merge, and archive this worktree by default",
			},
		]);
	});

	test("suggests explicit-base variants when base detection is missing", () => {
		// Arrange
		const options = {
			hasBranch: true,
			isDefaultBranch: false,
			hasLinkedWorktree: false,
			hasBaseBranch: false,
			hasPullRequest: false,
			ghAvailable: true,
			localChangesCount: 0,
			trackedChangesCount: 0,
			landingReadiness: "missing-base-branch" as const,
		};

		// Act
		const hints = buildStatusActionHints(options);

		// Assert
		expect(hints).toEqual([
			{
				command: "/wt rebase <branch>",
				detail: "rebase onto an explicit base branch when detection is missing",
			},
			{
				command: "/wt pr <branch>",
				detail: "create or view a PR against an explicit base branch",
			},
		]);
	});

	test("suggests /wt on the default branch", () => {
		// Arrange
		const options = {
			hasBranch: true,
			isDefaultBranch: true,
			hasLinkedWorktree: false,
			hasBaseBranch: false,
			hasPullRequest: false,
			ghAvailable: false,
			localChangesCount: 0,
			trackedChangesCount: 0,
			landingReadiness: null,
		};

		// Act
		const hints = buildStatusActionHints(options);

		// Assert
		expect(hints).toEqual([{ command: "/wt", detail: "switch worktrees or create a new feature worktree" }]);
	});
});
