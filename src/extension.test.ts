import * as assert from "assert";

import * as vscode from "vscode";
import {
  getTerminalForTesting,
  resetForTesting,
  syncPending,
  visibleTerminal,
  waitForSync,
} from "./extension";
import { parseCommand, Terminal, TerminalSettings } from "./model";
import { createSnapshotTester } from "./snapshot";

// Test helper that waits for both completion and sync
async function wait(): Promise<void> {
  const terminal = getTerminalForTesting();
  await terminal.waitForCompletion();
  await waitForSync();
}

// Helper functions for common test commands using node -e
function manyLinesCommand(lineCount: number): string {
  return `node -e "for(let i = 1; i <= ${lineCount}; i++) console.log('Line ' + i)"`;
}

function sleepCommand(seconds: number): string {
  return `node -e "setTimeout(() => { console.log('Done sleeping'); process.exit(0); }, ${
    seconds * 1000
  })"`;
}

function fastCommand(): string {
  return `node -e "console.log('Hello World')"`;
}

function errorCommand(): string {
  return `node -e "console.error('This is an error'); process.exit(1)"`;
}

function findTerminalDocument(): vscode.TextDocument | undefined {
  const terminalDocs = vscode.workspace.textDocuments.filter((doc) =>
    doc.uri.scheme === "terminal-editor"
  );

  if (terminalDocs.length > 1) {
    throw new Error(
      `Expected 0 or 1 terminal documents, found ${terminalDocs.length}`,
    );
  }

  return terminalDocs.length === 1 ? terminalDocs[0] : undefined;
}

suite("Extension Test Suite", () => {
  vscode.window.showInformationMessage("Start all tests.");
  const snapshot = createSnapshotTester();

  setup(async () => {
    // Close all editors
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // Reset the global terminal instance
    resetForTesting();
  });

  teardown(async () => {
    // Clean up after each test
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("Reveal command creates terminal", async () => {
    // Execute reveal command
    await vscode.commands.executeCommand("terminal-editor.reveal");

    // Check that terminal editor was created
    const doc = findTerminalDocument();
    assert.ok(doc, "Terminal document should be created");

    // Check that the document has expected content using snapshot
    const text = doc.getText();
    snapshot.expectSnapshot("reveal-command-creates-terminal", text);
  });

  test("Second reveal command does not create duplicate", async () => {
    // Execute reveal command twice
    await vscode.commands.executeCommand("terminal-editor.reveal");
    await vscode.commands.executeCommand("terminal-editor.reveal");

    // Check that only one terminal editor exists
    const doc = findTerminalDocument();
    assert.ok(doc, "Terminal document should exist and be unique");
  });

  test("Reveal works when terminal exists but not visible", async () => {
    // Create terminal and then close it
    await vscode.commands.executeCommand("terminal-editor.reveal");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

    // Execute reveal again
    await vscode.commands.executeCommand("terminal-editor.reveal");

    // Check that terminal is visible again
    const activeEditor = vscode.window.activeTextEditor;
    assert.ok(activeEditor);
    assert.strictEqual(activeEditor.document.uri.scheme, "terminal-editor");

    // Also verify using our helper function
    const doc = findTerminalDocument();
    assert.ok(doc, "Terminal document should still exist");
    assert.strictEqual(doc, activeEditor.document);
  });

  test("Terminal recreated after close", async () => {
    // Create terminal
    await vscode.commands.executeCommand("terminal-editor.reveal");

    // Close the document completely
    const terminalDoc = findTerminalDocument();
    if (terminalDoc) {
      await vscode.window.showTextDocument(terminalDoc);
      await vscode.commands.executeCommand(
        "workbench.action.closeActiveEditor",
      );
    }

    // Execute reveal again
    await vscode.commands.executeCommand("terminal-editor.reveal");

    // Check that new terminal was created
    const newDoc = findTerminalDocument();
    assert.ok(newDoc, "Terminal document should be recreated");
  });
});

suite("parseCommand Tests", () => {
  test("Simple command parsing", () => {
    const result = parseCommand("git status");
    assert.deepStrictEqual(result.tokens, ["git", "status"]);
    assert.strictEqual(result.cursorTokenIndex, undefined);
    assert.strictEqual(result.cursorTokenOffset, undefined);
  });

  test("Command with quoted arguments", () => {
    const result = parseCommand('echo "hello world" test');
    assert.deepStrictEqual(result.tokens, ["echo", "hello world", "test"]);
  });

  test("Empty command", () => {
    const result = parseCommand("");
    assert.deepStrictEqual(result.tokens, []);
  });

  test("Command with multiple spaces", () => {
    const result = parseCommand("  git   status   --short  ");
    assert.deepStrictEqual(result.tokens, ["git", "status", "--short"]);
  });

  test("Cursor at beginning of first token", () => {
    const result = parseCommand("git status", 0);
    assert.strictEqual(result.cursorTokenIndex, 0);
    assert.strictEqual(result.cursorTokenOffset, 0);
  });

  test("Cursor in middle of first token", () => {
    const result = parseCommand("git status", 2);
    assert.strictEqual(result.cursorTokenIndex, 0);
    assert.strictEqual(result.cursorTokenOffset, 2);
  });

  test("Cursor at end of first token", () => {
    const result = parseCommand("git status", 2);
    assert.strictEqual(result.cursorTokenIndex, 0);
    assert.strictEqual(result.cursorTokenOffset, 2);
  });

  test("Cursor on whitespace between tokens", () => {
    const result = parseCommand("git status", 3);
    assert.strictEqual(result.cursorTokenIndex, undefined);
    assert.strictEqual(result.cursorTokenOffset, undefined);
  });

  test("Cursor at beginning of second token", () => {
    const result = parseCommand("git status", 4);
    assert.strictEqual(result.cursorTokenIndex, 1);
    assert.strictEqual(result.cursorTokenOffset, 0);
  });

  test("Cursor at end of command", () => {
    const result = parseCommand("git status", 10);
    assert.strictEqual(result.cursorTokenIndex, 1);
    assert.strictEqual(result.cursorTokenOffset, 6);
  });

  test("Cursor at end of command with trailing space", () => {
    const result = parseCommand("git status ", 11);
    assert.strictEqual(result.cursorTokenIndex, undefined);
    assert.strictEqual(result.cursorTokenOffset, undefined);
  });

  test("Cursor in quoted string", () => {
    const result = parseCommand('echo "hello world"', 8);
    assert.strictEqual(result.cursorTokenIndex, 1);
    assert.strictEqual(result.cursorTokenOffset, 2);
  });

  test("Cursor at quote start", () => {
    const result = parseCommand('echo "hello world"', 5);
    assert.strictEqual(result.cursorTokenIndex, 1);
    assert.strictEqual(result.cursorTokenOffset, 0);
  });

  test("Multiple quoted arguments", () => {
    const result = parseCommand('cmd "arg1" "arg2 with spaces"');
    assert.deepStrictEqual(result.tokens, ["cmd", "arg1", "arg2 with spaces"]);
  });

  test("Empty quoted string", () => {
    const result = parseCommand('echo ""');
    assert.deepStrictEqual(result.tokens, ["echo", ""]);
  });

  test("Cursor in empty command", () => {
    const result = parseCommand("", 0);
    assert.strictEqual(result.cursorTokenIndex, undefined);
    assert.strictEqual(result.cursorTokenOffset, undefined);
  });
});

suite("Terminal Configuration Tests", () => {
  test("Terminal respects maxOutputLines configuration", async () => {
    const maxLines = 5;
    const mockSettings: TerminalSettings = {
      maxOutputLines: () => maxLines,
    };
    const terminal = new Terminal(mockSettings);

    // Run a command that produces many lines of output
    const totalLines = 20;
    const command = manyLinesCommand(totalLines);
    terminal.run(command);

    // Wait for the process to complete
    await terminal.waitForCompletion();

    // Get the output and verify it's limited to maxLines
    const output = terminal.output();
    const lines = output.text.split("\n").filter((line) => line.trim() !== "");

    // The output should be limited to maxLines
    // Since we generated 20 lines total and limit to 5, we should get the last 5: lines 16-20
    // But due to how split works with trailing newlines, we might get 4 content lines
    assert.ok(
      lines.length <= maxLines,
      `Got ${lines.length} lines, expected at most ${maxLines}`,
    );
    assert.ok(
      lines.length >= maxLines - 1,
      `Got ${lines.length} lines, expected at least ${maxLines - 1}`,
    );

    // Should contain the last lines
    assert.ok(
      lines[lines.length - 1].includes("Line 20"),
      "Should end with Line 20",
    );

    // Should start with Line 16 or 17 (depending on exact line count due to trailing newlines)
    const firstLine = lines[0];
    assert.ok(
      firstLine.includes("Line 16") || firstLine.includes("Line 17"),
      `First line should be Line 16 or 17, got: ${firstLine}`,
    );
  });

  test("Terminal handles non-existent command", async () => {
    const mockSettings: TerminalSettings = {
      maxOutputLines: () => 50,
    };
    const terminal = new Terminal(mockSettings);

    // Run a command that doesn't exist
    terminal.run("this-command-definitely-does-not-exist-12345");

    // Wait for the process to complete
    await terminal.waitForCompletion();

    // Check that the terminal shows completed status
    const status = terminal.status();
    assert.ok(
      status.text.includes("status: 127"),
      `Expected status with exit code 127, got: ${status.text}`,
    );

    // Check that error message is in output
    const output = terminal.output();
    assert.ok(
      output.text.includes("ENOENT"),
      `Expected ENOENT error message, got: ${output.text}`,
    );
  });

  test("Terminal respects working directory", async () => {
    const mockSettings: TerminalSettings = {
      maxOutputLines: () => 50,
    };

    // Create terminal with specific working directory
    const testWorkingDir = "/tmp";
    const terminal = new Terminal(mockSettings, {}, testWorkingDir);

    // Run pwd command to verify working directory
    terminal.run("pwd");

    // Wait for the process to complete
    await terminal.waitForCompletion();

    // Check that the output shows the correct working directory
    const output = terminal.output();
    assert.ok(
      output.text.includes("/tmp"),
      `Expected output to contain /tmp, got: ${output.text}`,
    );
  });
});

suite("Run Command Tests", () => {
  const snapshot = createSnapshotTester();

  setup(async () => {
    // Close all editors
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // Reset the global terminal instance
    resetForTesting();
  });

  teardown(async () => {
    // Clean up after each test
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("Run command executes simple command and shows output", async () => {
    // Create terminal
    await vscode.commands.executeCommand("terminal-editor.reveal");

    // Get the terminal editor
    const activeEditor = vscode.window.activeTextEditor;
    assert.ok(activeEditor);
    assert.strictEqual(activeEditor.document.uri.scheme, "terminal-editor");

    // Insert a simple command
    const command = fastCommand();
    await activeEditor.edit((editBuilder) => {
      editBuilder.replace(new vscode.Range(0, 0, 0, 0), command);
    });

    // Run the command
    await vscode.commands.executeCommand("terminal-editor.run");

    // Wait for the process to complete
    const terminal = getTerminalForTesting();
    await terminal.waitForCompletion();

    // Wait for final sync to complete
    await waitForSync();

    // Check that the output contains the expected result using snapshot
    const text = activeEditor.document.getText();
    snapshot.expectSnapshot("run-command-simple-output", text);
  });

  test("Run command handles command with error exit code", async () => {
    // Create terminal
    await vscode.commands.executeCommand("terminal-editor.reveal");

    // Get the terminal editor
    const activeEditor = vscode.window.activeTextEditor;
    assert.ok(activeEditor);

    // Insert a command that exits with error
    const command = errorCommand();
    await activeEditor.edit((editBuilder) => {
      editBuilder.replace(new vscode.Range(0, 0, 0, 0), command);
    });

    // Run the command
    await vscode.commands.executeCommand("terminal-editor.run");

    // Wait for the process to complete
    const terminal = getTerminalForTesting();
    await terminal.waitForCompletion();

    // Wait for final sync to complete
    await waitForSync();

    // Check that the output shows error exit code using snapshot
    const text = activeEditor.document.getText();
    snapshot.expectSnapshot("run-command-error-exit-code", text);
  });

  test("Run command shows runtime updates", async function () {
    // Skip slow test unless SLOW_TESTS environment variable is set
    if (!process.env.SLOW_TESTS) {
      this.skip();
      return;
    }

    // Increase timeout for this test
    this.timeout(8000);

    // Create terminal
    await vscode.commands.executeCommand("terminal-editor.reveal");

    // Get the terminal editor
    const activeEditor = vscode.window.activeTextEditor;
    assert.ok(activeEditor);

    // Insert a command that sleeps for a short time
    const command = sleepCommand(3);
    await activeEditor.edit((editBuilder) => {
      editBuilder.replace(new vscode.Range(0, 0, 0, 0), command);
    });

    // Run the command
    await vscode.commands.executeCommand("terminal-editor.run");

    // Wait briefly and check that runtime is shown (should be running)
    // Note: This setTimeout is intentional - we need to check intermediate state while process is running
    await new Promise((resolve) => setTimeout(resolve, 1500));
    let text = activeEditor.document.getText();
    assert.ok(
      text.includes(" time:"),
      `Expected status line with time, got: ${text}`,
    );
    assert.ok(
      !text.includes("status:"),
      `Should not show status while running, got: ${text}`,
    );

    // Wait for completion
    const terminal = getTerminalForTesting();
    await terminal.waitForCompletion();

    // Wait for final sync to complete
    await waitForSync();

    text = activeEditor.document.getText();
    snapshot.expectSnapshot("run-command-runtime-updates-final", text);
  });

  test("Run command with no terminal editor shows error", async () => {
    // Don't create a terminal editor first

    // Try to run command - should show error
    await vscode.commands.executeCommand("terminal-editor.run");

    // We can't easily test the error message display, but the command should not crash
    // The test passes if no exception is thrown
  });

  test("Run command with empty command shows error", async () => {
    // Create terminal with empty command
    await vscode.commands.executeCommand("terminal-editor.reveal");

    // Get the terminal editor - it should be empty initially
    const activeEditor = vscode.window.activeTextEditor;
    assert.ok(activeEditor);

    // Run the command (should fail due to empty command)
    await vscode.commands.executeCommand("terminal-editor.run");

    // The test passes if no exception is thrown
  });

  test("Run command kills previous process when new one starts", async () => {
    // Create terminal
    await vscode.commands.executeCommand("terminal-editor.reveal");

    // Get the terminal editor
    const activeEditor = vscode.window.activeTextEditor;
    assert.ok(activeEditor);

    // Insert a long-running command
    const longCommand = sleepCommand(10);
    await activeEditor.edit((editBuilder) => {
      editBuilder.replace(new vscode.Range(0, 0, 0, 0), longCommand);
    });

    // Run the first command
    await vscode.commands.executeCommand("terminal-editor.run");

    // Replace with a quick command
    const quickCommand = fastCommand();
    await activeEditor.edit((editBuilder) => {
      const doc = activeEditor.document;
      const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
      editBuilder.replace(fullRange, quickCommand);
    });

    // Run the second command
    await vscode.commands.executeCommand("terminal-editor.run");

    // Wait for completion
    const terminal = getTerminalForTesting();
    await terminal.waitForCompletion();

    // Wait for final sync to complete
    await waitForSync();

    // Check that we got output from the second command using snapshot
    const text = activeEditor.document.getText();
    snapshot.expectSnapshot("run-command-kills-previous-process", text);
  });

  test("Run command handles non-existent command", async () => {
    // Create terminal
    await vscode.commands.executeCommand("terminal-editor.reveal");

    // Get the terminal editor
    const activeEditor = vscode.window.activeTextEditor;
    assert.ok(activeEditor);

    // Insert a command that doesn't exist
    const nonExistentCommand = "this-command-definitely-does-not-exist-12345";
    await activeEditor.edit((editBuilder) => {
      editBuilder.replace(new vscode.Range(0, 0, 0, 0), nonExistentCommand);
    });

    // Run the command
    await vscode.commands.executeCommand("terminal-editor.run");

    // Wait for completion and sync
    const terminal = getTerminalForTesting();
    await terminal.waitForCompletion();
    await waitForSync();

    // Check that the output shows appropriate error using snapshot
    const text = activeEditor.document.getText();
    snapshot.expectSnapshot("run-command-non-existent-command", text);
  });
});

suite("DWIM Command Tests", () => {
  const snapshot = createSnapshotTester();

  setup(async () => {
    // Close all editors
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // Reset the global terminal instance
    resetForTesting();
  });

  teardown(async () => {
    // Clean up after each test
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("DWIM reveals terminal when not visible", async () => {
    // Make sure no terminal editor is visible (may exist but not visible)
    const visibleEditor = visibleTerminal();
    assert.strictEqual(
      visibleEditor,
      undefined,
      "No terminal should be visible initially",
    );

    // Execute dwim command
    await vscode.commands.executeCommand("terminal-editor.dwim");

    // Check that terminal is now active
    const activeEditor = vscode.window.activeTextEditor;
    assert.ok(activeEditor, "Terminal editor should be active");
    assert.strictEqual(activeEditor.document.uri.scheme, "terminal-editor");
  });

  test("DWIM focuses terminal when visible but not focused", async () => {
    // Create terminal first
    await vscode.commands.executeCommand("terminal-editor.reveal");

    // Focus away from terminal by creating a new text document
    const newDoc = await vscode.workspace.openTextDocument({
      content: "some other content",
    });
    await vscode.window.showTextDocument(newDoc);

    // Verify terminal is not focused
    const activeEditor = vscode.window.activeTextEditor;
    assert.ok(activeEditor);
    assert.notStrictEqual(activeEditor.document.uri.scheme, "terminal-editor");

    // Execute dwim command
    await vscode.commands.executeCommand("terminal-editor.dwim");

    // Check that terminal is now focused
    const newActiveEditor = vscode.window.activeTextEditor;
    assert.ok(newActiveEditor, "Terminal editor should be active");
    assert.strictEqual(newActiveEditor.document.uri.scheme, "terminal-editor");
  });

  test("DWIM runs command when terminal is focused", async () => {
    // Create and focus terminal
    await vscode.commands.executeCommand("terminal-editor.reveal");

    // Get the terminal editor and add a command
    const activeEditor = vscode.window.activeTextEditor;
    assert.ok(activeEditor);
    assert.strictEqual(activeEditor.document.uri.scheme, "terminal-editor");

    // Insert a simple command
    const command = fastCommand();
    await activeEditor.edit((editBuilder) => {
      editBuilder.replace(new vscode.Range(0, 0, 0, 0), command);
    });

    // Execute dwim command (should run the command since terminal is focused)
    await vscode.commands.executeCommand("terminal-editor.dwim");

    // Wait for completion
    const terminal = getTerminalForTesting();
    await terminal.waitForCompletion();

    // Wait for final sync to complete
    await waitForSync();

    // Check that the command was executed using snapshot
    const text = activeEditor.document.getText();
    snapshot.expectSnapshot("dwim-runs-command-when-focused", text);
  });

  test("Terminal uses workspace root as working directory", async () => {
    // Create terminal
    await vscode.commands.executeCommand("terminal-editor.reveal");

    // Get the terminal editor and add pwd command
    const activeEditor = vscode.window.activeTextEditor;
    assert.ok(activeEditor);
    assert.strictEqual(activeEditor.document.uri.scheme, "terminal-editor");

    // Insert pwd command to check working directory
    const command = 'node -e "console.log(process.cwd())"';
    await activeEditor.edit((editBuilder) => {
      editBuilder.replace(new vscode.Range(0, 0, 0, 0), command);
    });

    // Run the command
    await vscode.commands.executeCommand("terminal-editor.run");

    // Wait for completion
    const terminal = getTerminalForTesting();
    await terminal.waitForCompletion();

    // Wait for final sync to complete
    await waitForSync();

    // Check that the output shows the current working directory
    const text = activeEditor.document.getText();
    assert.ok(
      text.includes("/Users/matklad/p/terminal-editor"),
      `Expected output to contain workspace root path, got: ${text}`,
    );
  });
});

suite("Fold/Unfold Mode Tests", () => {
  const snapshot = createSnapshotTester();

  setup(async () => {
    // Close all editors
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // Reset the global terminal instance
    resetForTesting();
  });

  teardown(async () => {
    // Clean up after each test
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("toggleFold command works in extension", async () => {
    // Override the maxOutputLines setting to 3 for this test
    const originalGetConfiguration = vscode.workspace.getConfiguration;
    vscode.workspace.getConfiguration = () => ({
      get: (key: string, defaultValue?: any) => {
        if (key === "maxOutputLines") {
          return 3;
        }
        return defaultValue;
      },
    }) as any;

    try {
      // Create terminal
      await vscode.commands.executeCommand("terminal-editor.reveal");

      // Get the terminal editor
      const activeEditor = vscode.window.activeTextEditor;
      assert.ok(activeEditor);
      assert.strictEqual(activeEditor.document.uri.scheme, "terminal-editor");

      // Insert a command that produces many lines
      const command = manyLinesCommand(10);
      await activeEditor.edit((editBuilder) => {
        editBuilder.replace(new vscode.Range(0, 0, 0, 0), command);
      });

      // Run the command
      await vscode.commands.executeCommand("terminal-editor.run");

      // Wait for completion
      const terminal = getTerminalForTesting();
      await terminal.waitForCompletion();
      await waitForSync();

      // Get the initial (folded) text
      let text = activeEditor.document.getText();
      snapshot.expectSnapshot("toggle-fold-initial-folded", text);

      // Execute toggleFold command
      await vscode.commands.executeCommand("terminal-editor.toggleFold");
      await waitForSync();

      // Get the unfolded text
      text = activeEditor.document.getText();
      snapshot.expectSnapshot("toggle-fold-after-unfold", text);

      // Execute toggleFold command again
      await vscode.commands.executeCommand("terminal-editor.toggleFold");
      await waitForSync();

      // Get the re-folded text
      text = activeEditor.document.getText();
      snapshot.expectSnapshot("toggle-fold-after-refold", text);
    } finally {
      // Restore original getConfiguration
      vscode.workspace.getConfiguration = originalGetConfiguration;
    }
  });

  test("Tab key toggles fold when cursor on status line with ellipsis", async () => {
    // Override the maxOutputLines setting to 3 for this test
    const originalGetConfiguration = vscode.workspace.getConfiguration;
    vscode.workspace.getConfiguration = () => ({
      get: (key: string, defaultValue?: any) => {
        if (key === "maxOutputLines") {
          return 3;
        }
        return defaultValue;
      },
    }) as any;

    try {
      // Create terminal
      await vscode.commands.executeCommand("terminal-editor.reveal");

      // Get the terminal editor
      const activeEditor = vscode.window.activeTextEditor;
      assert.ok(activeEditor);
      assert.strictEqual(activeEditor.document.uri.scheme, "terminal-editor");

      // Insert a command that produces many lines
      const command = manyLinesCommand(10);
      await activeEditor.edit((editBuilder) => {
        editBuilder.replace(new vscode.Range(0, 0, 0, 0), command);
      });

      // Run the command
      await vscode.commands.executeCommand("terminal-editor.run");

      // Wait for completion
      const terminal = getTerminalForTesting();
      await terminal.waitForCompletion();
      await waitForSync();

      // Find the status line (should contain "..." since output is truncated)
      const text = activeEditor.document.getText();
      const lines = text.split('\n');
      let statusLineIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('=') && lines[i].includes('time:')) {
          statusLineIndex = i;
          break;
        }
      }
      assert.ok(statusLineIndex >= 0, "Status line not found");
      assert.ok(lines[statusLineIndex].includes('...'), "Status line should contain ellipsis for truncated output");

      // Position cursor on the status line
      const position = new vscode.Position(statusLineIndex, 5); // Somewhere in the middle of status line
      activeEditor.selection = new vscode.Selection(position, position);

      // Verify we're in folded mode initially
      assert.ok(terminal.isFolded(), "Terminal should be in folded mode initially");

      // Test our toggleFold command when cursor is on status line with ellipsis
      // (This simulates the Tab key behavior)
      await vscode.commands.executeCommand("terminal-editor.toggleFold");
      await waitForSync();
      
      // Verify the terminal is now unfolded
      assert.ok(!terminal.isFolded(), "Terminal should be unfolded after Tab on status line with ellipsis");

      // Test that positioning cursor on status line when it has ellipsis works
      // (We already tested this above and it worked)
      
      // Now test positioning cursor on status line when it does NOT have ellipsis (unfolded)
      // Position cursor back on the status line (but now it shouldn't have ellipsis)
      const updatedText = activeEditor.document.getText();
      const updatedLines = updatedText.split('\n');
      let updatedStatusLineIndex = -1;
      for (let i = 0; i < updatedLines.length; i++) {
        if (updatedLines[i].startsWith('=') && updatedLines[i].includes('time:')) {
          updatedStatusLineIndex = i;
          break;
        }
      }
      
      const statusPosition = new vscode.Position(updatedStatusLineIndex, 5);
      activeEditor.selection = new vscode.Selection(statusPosition, statusPosition);
      
      // Call toggleFold - this should NOT toggle because there's no ellipsis in unfolded mode
      const wasUnfolded = !terminal.isFolded();
      await vscode.commands.executeCommand("terminal-editor.toggleFold");
      await waitForSync();
      
      // Should execute default tab behavior since no ellipsis, so state shouldn't change
      assert.strictEqual(terminal.isFolded(), !wasUnfolded, "Terminal fold state should not change when status line has no ellipsis");
      
      // Position cursor on non-status line and test
      const nonStatusPosition = new vscode.Position(0, 0); // First line (command line)
      activeEditor.selection = new vscode.Selection(nonStatusPosition, nonStatusPosition);
      
      // Call toggleFold - this should NOT toggle because cursor is not on status line
      const currentFoldState = terminal.isFolded();
      await vscode.commands.executeCommand("terminal-editor.toggleFold");
      await waitForSync();
      
      // Should execute default tab behavior, so fold state shouldn't change
      assert.strictEqual(terminal.isFolded(), currentFoldState, "Terminal fold state should not change when cursor is not on status line");

    } finally {
      // Restore original getConfiguration
      vscode.workspace.getConfiguration = originalGetConfiguration;
    }
  });
});
