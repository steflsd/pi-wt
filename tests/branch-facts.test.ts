import { describe, expect, test } from "vitest";
import { hasMergedPullRequestAtHead } from "../src/branch-facts.js";

describe("hasMergedPullRequestAtHead", () => {
	test("returns true for a merged PR whose head matches the current HEAD and base branch", () => {
		// Arrange
		const facts = {
			pullRequest: {
				number: 594,
				title: "Example PR",
				url: "https://github.com/example/repo/pull/594",
				state: "MERGED",
				isDraft: false,
				baseRefName: "main",
				headRefName: "fix/run",
				headRefOid: "abc123",
			},
			currentHead: "abc123",
			baseBranch: {
				name: "main",
				ref: "refs/heads/main",
				source: "current PR base",
			},
		};

		// Act
		const result = hasMergedPullRequestAtHead(facts);

		// Assert
		expect(result).toBe(true);
	});

	test("returns false when the merged PR targets a different base branch", () => {
		// Arrange
		const facts = {
			pullRequest: {
				number: 594,
				title: "Example PR",
				url: "https://github.com/example/repo/pull/594",
				state: "MERGED",
				isDraft: false,
				baseRefName: "release",
				headRefName: "fix/run",
				headRefOid: "abc123",
			},
			currentHead: "abc123",
			baseBranch: {
				name: "main",
				ref: "refs/heads/main",
				source: "archive target",
			},
		};

		// Act
		const result = hasMergedPullRequestAtHead(facts);

		// Assert
		expect(result).toBe(false);
	});
});
