import { describe, expect, test } from "vitest";
import { resolveArchiveMergeAssessment } from "../src/worktrees.js";

describe("resolveArchiveMergeAssessment", () => {
	test("marks a branch as merged when Git ancestry confirms it", () => {
		// Arrange
		const input = {
			branch: "feat/example",
			mergeTarget: "main",
			mergedIntoTarget: true,
			mergedPullRequestAtHead: false,
		};

		// Act
		const result = resolveArchiveMergeAssessment(input);

		// Assert
		expect(result).toEqual({ deleteBranch: true, mergeState: "merged-by-git" });
	});

	test("marks a branch as merged when the current head already has a merged PR into the target", () => {
		// Arrange
		const input = {
			branch: "feat/example",
			mergeTarget: "main",
			mergedIntoTarget: false,
			mergedPullRequestAtHead: true,
		};

		// Act
		const result = resolveArchiveMergeAssessment(input);

		// Assert
		expect(result).toEqual({ deleteBranch: true, mergeState: "merged-by-pr" });
	});

	test("keeps a branch when neither Git ancestry nor PR state confirms the merge", () => {
		// Arrange
		const input = {
			branch: "feat/example",
			mergeTarget: "main",
			mergedIntoTarget: false,
			mergedPullRequestAtHead: false,
		};

		// Act
		const result = resolveArchiveMergeAssessment(input);

		// Assert
		expect(result).toEqual({ deleteBranch: false, mergeState: "not-merged" });
	});
});
