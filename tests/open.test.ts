import { describe, expect, test } from "vitest";
import { buildGhosttyLaunchScript, buildGhosttyOpenScript } from "../src/commands/open.js";

describe("Ghostty AppleScript helpers", () => {
	test("buildGhosttyOpenScript opens a new tab in a running Ghostty window and otherwise creates a new window", () => {
		// Arrange

		// Act
		const script = buildGhosttyOpenScript();

		// Assert
		expect(script).toContain('set ghosttyRunning to application "Ghostty" is running');
		expect(script).toContain('tell application "Ghostty"');
		expect(script).toContain("set initial working directory to cwd");
		expect(script).not.toContain("set launchCommand to item 2 of argv");
		expect(script).toContain("if ghosttyRunning and (count of windows) > 0 then");
		expect(script).toContain("new tab in front window with configuration cfg");
		expect(script).toContain("new window with configuration cfg");
		expect(script).toContain("activate");
	});

	test("buildGhosttyLaunchScript pastes the launch command into the new Ghostty surface", () => {
		// Arrange

		// Act
		const script = buildGhosttyLaunchScript();

		// Assert
		expect(script).toContain("set cwd to item 1 of argv");
		expect(script).toContain("set launchCommand to item 2 of argv");
		expect(script).toContain("set initial working directory to cwd");
		expect(script).toContain("set initial input to launchCommand & return");
		expect(script).toContain("if ghosttyRunning and (count of windows) > 0 then");
		expect(script).toContain("new tab in front window with configuration cfg");
		expect(script).toContain("new window with configuration cfg");
	});
});
