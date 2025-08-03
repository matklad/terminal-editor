import * as assert from "assert";

import * as vscode from "vscode";
import {
  getTerminalForTesting,
  resetForTesting,
  visibleTerminal,
  waitForSync,
} from "./extension";
import { ANSIText, parseCommand, Terminal, TerminalSettings } from "./model";
import { createSnapshotTester } from "./snapshot";

// Shared test helpers
async function wait(): Promise<void> {
  const terminal = getTerminalForTesting();
  await terminal.waitForCompletion();
  await waitForSync();
}

async function assertEdit(
  editor: vscode.TextEditor,
  editCallback: (editBuilder: vscode.TextEditorEdit) => void,
): Promise<void> {
  const success = await editor.edit(editCallback);
  assert.ok(success, "Editor edit should succeed");
}

// Shared setup/teardown functions
async function setupTest(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  resetForTesting();
}

async function teardownTest(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

// Helper to decode semantic tokens and extract their text ranges
interface DecodedToken {
  line: number;
  character: number;
  length: number;
  tokenType: number;
  tokenText: string;
  expectedType: string;
}

function decodeSemanticTokens(
  document: vscode.TextDocument,
  tokens: vscode.SemanticTokens,
  legend: vscode.SemanticTokensLegend,
): DecodedToken[] {
  const decoded: DecodedToken[] = [];
  const data = tokens.data;

  let line = 0;
  let character = 0;

  // Semantic tokens are encoded as [deltaLine, deltaChar, length, tokenType, tokenModifiers]
  for (let i = 0; i < data.length; i += 5) {
    const deltaLine = data[i];
    const deltaChar = data[i + 1];
    const length = data[i + 2];
    const tokenType = data[i + 3];

    // Update position - VSCode semantic tokens use delta encoding
    if (deltaLine > 0) {
      line += deltaLine;
      character = deltaChar; // Reset character to delta when line changes
    } else {
      character += deltaChar; // Add to character when staying on same line
    }

    // Ensure we don't go out of bounds
    if (line >= document.lineCount) {
      console.warn(
        `Token line ${line} is out of bounds (document has ${document.lineCount} lines)`,
      );
      continue;
    }

    const lineText = document.lineAt(line).text;
    if (character >= lineText.length || character + length > lineText.length) {
      console.warn(
        `Token at ${line}:${character} length ${length} is out of bounds for line: "${lineText}"`,
      );
      continue;
    }

    // Extract the actual text from the document
    const startPos = new vscode.Position(line, character);
    const endPos = new vscode.Position(line, character + length);
    const tokenText = document.getText(new vscode.Range(startPos, endPos));

    const expectedType = legend.tokenTypes[tokenType] || `unknown-${tokenType}`;

    decoded.push({
      line,
      character,
      length,
      tokenType,
      tokenText,
      expectedType,
    });
  }

  return decoded;
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

suite("Terminal Editor Core", () => {
  const snapshot = createSnapshotTester();

  setup(setupTest);
  teardown(teardownTest);

  test("Terminal reveal and management", async () => {
    // Execute reveal command creates terminal
    await vscode.commands.executeCommand("terminal-editor.reveal");
    const doc = findTerminalDocument();
    assert.ok(doc, "Terminal document should be created");
    snapshot.expectSnapshot("reveal-command-creates-terminal", doc.getText());

    // Second reveal doesn't create duplicate
    await vscode.commands.executeCommand("terminal-editor.reveal");
    assert.strictEqual(findTerminalDocument(), doc, "Should reuse existing terminal");

    // Reveal works when terminal exists but not visible
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await vscode.commands.executeCommand("terminal-editor.reveal");
    const activeEditor = vscode.window.activeTextEditor;
    assert.ok(activeEditor);
    assert.strictEqual(activeEditor.document.uri.scheme, "terminal-editor");
  });
});

suite("parseCommand Tests", () => {
  test("Command parsing basics", () => {
    // Simple parsing
    let result = parseCommand("git status");
    assert.deepStrictEqual(result.tokens, ["git", "status"]);
    assert.strictEqual(result.cursorTokenIndex, undefined);

    // Quoted arguments
    result = parseCommand('echo "hello world" test');
    assert.deepStrictEqual(result.tokens, ["echo", "hello world", "test"]);

    // Multiple spaces
    result = parseCommand("  git   status   --short  ");
    assert.deepStrictEqual(result.tokens, ["git", "status", "--short"]);

    // Empty command
    result = parseCommand("");
    assert.deepStrictEqual(result.tokens, []);
  });

  test("Cursor position tracking", () => {
    // Cursor in token
    let result = parseCommand("git status", 2);
    assert.strictEqual(result.cursorTokenIndex, 0);
    assert.strictEqual(result.cursorTokenOffset, 2);

    // Cursor on whitespace
    result = parseCommand("git status", 3);
    assert.strictEqual(result.cursorTokenIndex, undefined);

    // Cursor in quoted string
    result = parseCommand('echo "hello world"', 8);
    assert.strictEqual(result.cursorTokenIndex, 1);
    assert.strictEqual(result.cursorTokenOffset, 2);
  });

  test("Quote handling", () => {
    // Multiple quoted args
    let result = parseCommand('cmd "arg1" "arg2 with spaces"');
    assert.deepStrictEqual(result.tokens, ["cmd", "arg1", "arg2 with spaces"]);

    // Empty quoted string
    result = parseCommand('echo ""');
    assert.deepStrictEqual(result.tokens, ["echo", ""]);
  });
});

suite("Terminal Configuration", () => {
  test("Terminal configuration and behavior", async () => {
    // Test maxOutputLines
    const maxLines = 5;
    const mockSettings: TerminalSettings = { maxOutputLines: () => maxLines };
    const terminal = new Terminal(mockSettings);
    
    terminal.run(manyLinesCommand(20));
    await terminal.waitForCompletion();
    
    const output = terminal.output();
    const lines = output.text.split("\n").filter((line) => line.trim() !== "");
    assert.ok(lines.length <= maxLines, `Got ${lines.length} lines, expected at most ${maxLines}`);
    assert.ok(lines[lines.length - 1].includes("Line 20"), "Should end with Line 20");

    // Test error handling
    const errorTerminal = new Terminal(mockSettings);
    errorTerminal.run("this-command-definitely-does-not-exist-12345");
    await errorTerminal.waitForCompletion();
    
    const status = errorTerminal.status();
    assert.ok(status.text.includes("status: 127"), "Should show exit code 127 for non-existent command");

    // Test working directory
    const wdTerminal = new Terminal(mockSettings, {}, "/tmp");
    wdTerminal.run("pwd");
    await wdTerminal.waitForCompletion();
    
    const wdOutput = wdTerminal.output();
    assert.ok(wdOutput.text.includes("/tmp"), "Should respect working directory");
  });
});

suite("Command Execution", () => {
  const snapshot = createSnapshotTester();
  setup(setupTest);
  teardown(teardownTest);

  test("Command execution and output", async () => {
    await vscode.commands.executeCommand("terminal-editor.reveal");
    const activeEditor = vscode.window.activeTextEditor!;
    assert.strictEqual(activeEditor.document.uri.scheme, "terminal-editor");

    // Test successful command
    await assertEdit(activeEditor, (editBuilder) => {
      editBuilder.replace(new vscode.Range(0, 0, 0, 0), fastCommand());
    });
    await vscode.commands.executeCommand("terminal-editor.run");
    await wait();
    snapshot.expectSnapshot("run-command-simple-output", activeEditor.document.getText());

    // Test error command
    await assertEdit(activeEditor, (editBuilder) => {
      const doc = activeEditor.document;
      const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
      editBuilder.delete(fullRange);
      editBuilder.insert(new vscode.Position(0, 0), errorCommand());
    });
    await vscode.commands.executeCommand("terminal-editor.run");
    await wait();
    snapshot.expectSnapshot("run-command-error-exit-code", activeEditor.document.getText());
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
    await assertEdit(activeEditor, (editBuilder) => {
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
    await wait();
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
    await assertEdit(activeEditor, (editBuilder) => {
      editBuilder.replace(new vscode.Range(0, 0, 0, 0), longCommand);
    });

    // Run the first command
    await vscode.commands.executeCommand("terminal-editor.run");

    // Wait a brief moment for the first command to start, then replace with a quick command
    await new Promise((resolve) => setTimeout(resolve, 100));

    const quickCommand = fastCommand();
    await assertEdit(activeEditor, (editBuilder) => {
      // Clear all content first
      const doc = activeEditor.document;
      const fullText = doc.getText();
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(fullText.length),
      );
      editBuilder.delete(fullRange);
      editBuilder.insert(new vscode.Position(0, 0), quickCommand);
    });

    // Run the second command
    await vscode.commands.executeCommand("terminal-editor.run");
    // Wait for completion
    await wait();

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
    await assertEdit(activeEditor, (editBuilder) => {
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
    await assertEdit(activeEditor, (editBuilder) => {
      editBuilder.replace(new vscode.Range(0, 0, 0, 0), command);
    });

    // Execute dwim command (should run the command since terminal is focused)
    await vscode.commands.executeCommand("terminal-editor.dwim");

    // Wait for completion
    await wait();
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
    await assertEdit(activeEditor, (editBuilder) => {
      editBuilder.replace(new vscode.Range(0, 0, 0, 0), command);
    });

    // Run the command
    await vscode.commands.executeCommand("terminal-editor.run");

    // Wait for completion
    await wait();
    // Check that the output shows the current working directory
    const text = activeEditor.document.getText();
    assert.ok(
      text.includes("/Users/matklad/p/terminal-editor"),
      `Expected output to contain workspace root path, got: ${text}`,
    );
  });
});

suite("Syntax Highlighting Tests", () => {
  test("Terminal.status() returns proper highlighting ranges for basic status", () => {
    const mockSettings: TerminalSettings = {
      maxOutputLines: () => 50,
    };
    const terminal = new Terminal(mockSettings);

    const result = terminal.status();

    // Should be "= ="
    assert.strictEqual(result.text, "= =");
    assert.strictEqual(result.ranges.length, 2);

    // Both '=' characters should be punctuation
    assert.strictEqual(result.ranges[0].tag, "punctuation");
    assert.strictEqual(result.ranges[0].range.start.character, 0);
    assert.strictEqual(result.ranges[0].range.end.character, 1);
    assert.strictEqual(result.ranges[1].tag, "punctuation");
    assert.strictEqual(result.ranges[1].range.start.character, 2);
    assert.strictEqual(result.ranges[1].range.end.character, 3);
  });

  test("Terminal.status() returns proper highlighting ranges with runtime and status", async () => {
    const mockSettings: TerminalSettings = {
      maxOutputLines: () => 50,
    };
    const terminal = new Terminal(mockSettings);

    // Run a simple command to get runtime and status
    terminal.run(fastCommand());
    await terminal.waitForCompletion();

    const result = terminal.status();

    // Should contain time and status information with proper ranges
    assert.ok(result.text.includes("time:"));
    assert.ok(result.text.includes("status:"));

    // Find expected ranges
    let foundKeywordRanges = 0;
    let foundTimeRange = false;
    let foundStatusRange = false;
    let foundPunctuationRanges = 0;

    for (const range of result.ranges) {
      const rangeText = result.text.substring(
        range.range.start.character,
        range.range.end.character,
      );

      if (range.tag === "keyword") {
        foundKeywordRanges++;
        assert.ok(
          rangeText === "time:" || rangeText === "status:",
          `Unexpected keyword range: ${rangeText}`,
        );
      } else if (range.tag === "time") {
        foundTimeRange = true;
        assert.ok(
          rangeText.match(/^\d+s$/),
          `Time range should match duration format: ${rangeText}`,
        );
      } else if (range.tag === "status_ok" || range.tag === "status_err") {
        foundStatusRange = true;
        assert.ok(
          rangeText === "0" || rangeText === "1",
          `Status range should be exit code: ${rangeText}`,
        );
      } else if (range.tag === "punctuation") {
        foundPunctuationRanges++;
        assert.strictEqual(
          rangeText,
          "=",
          `Punctuation range should be '=': ${rangeText}`,
        );
      }
    }

    assert.strictEqual(
      foundKeywordRanges,
      2,
      "Should have 2 keyword ranges (time: and status:)",
    );
    assert.ok(foundTimeRange, "Should have a time range");
    assert.ok(foundStatusRange, "Should have a status range");
    assert.strictEqual(
      foundPunctuationRanges,
      2,
      "Should have 2 punctuation ranges (opening and closing =)",
    );
  });

  test("Terminal.status() uses status_ok for zero exit code", async () => {
    const mockSettings: TerminalSettings = {
      maxOutputLines: () => 50,
    };
    const terminal = new Terminal(mockSettings);

    // Run a command that succeeds
    terminal.run(fastCommand());
    await terminal.waitForCompletion();

    const result = terminal.status();

    const statusRanges = result.ranges.filter((r) =>
      r.tag === "status_ok" || r.tag === "status_err"
    );
    assert.strictEqual(
      statusRanges.length,
      1,
      "Should have exactly one status range",
    );
    assert.strictEqual(
      statusRanges[0].tag,
      "status_ok",
      "Should use status_ok for zero exit code",
    );
  });

  test("Terminal.status() uses status_err for non-zero exit code", async () => {
    const mockSettings: TerminalSettings = {
      maxOutputLines: () => 50,
    };
    const terminal = new Terminal(mockSettings);

    // Run a command that fails
    terminal.run(errorCommand());
    await terminal.waitForCompletion();

    const result = terminal.status();

    const statusRanges = result.ranges.filter((r) =>
      r.tag === "status_ok" || r.tag === "status_err"
    );
    assert.strictEqual(
      statusRanges.length,
      1,
      "Should have exactly one status range",
    );
    assert.strictEqual(
      statusRanges[0].tag,
      "status_err",
      "Should use status_err for non-zero exit code",
    );
  });

  test("Terminal.output() returns empty ranges for simple output", async () => {
    const mockSettings: TerminalSettings = {
      maxOutputLines: () => 50,
    };
    const terminal = new Terminal(mockSettings);

    // Test with no output
    let result = terminal.output();
    assert.strictEqual(result.text, "");
    assert.strictEqual(result.ranges.length, 0);

    // Test with simple output that has no file paths or errors
    terminal.run(fastCommand());
    await terminal.waitForCompletion();

    result = terminal.output();
    assert.ok(result.text.length > 0, "Should have some output text");
    assert.strictEqual(
      result.ranges.length,
      0,
      "Should have no ranges for simple output",
    );
  });

  test("ANSIText handles line drawing characters", () => {
    const ansiText = new ANSIText();

    // Test DEC Special Character Set escape sequences
    ansiText.append("\x1b(0tq x mq\x1b(B normal text");

    const result = ansiText.getTextWithRanges();

    // Should convert line drawing characters to Unicode
    assert.strictEqual(result.text, "├─ │ └─ normal text");

    // Raw input should still contain original escape sequences
    assert.ok(ansiText.getRawInput().includes("\x1b(0"));
    assert.ok(ansiText.getRawInput().includes("\x1b(B"));
  });

  test("ANSIText handles combined ANSI colors and line drawing", () => {
    const ansiText = new ANSIText();

    // Test combination of colors and line drawing (like in zig build output)
    ansiText.append(
      "\x1b[2mcheck\n\x1b(0tq\x1b(B zig build-exe \x1b[31m1 errors\x1b[0m\n",
    );
    ansiText.append("src/main.zig:10:5: \x1b[31merror:\x1b[0m message");

    const result = ansiText.getTextWithRanges();

    // Should have properly converted line drawing chars
    assert.ok(result.text.includes("├─"));

    // Should detect ANSI color ranges
    const dimRanges = result.ranges.filter((r) => r.tag === "ansi_dim");
    const redRanges = result.ranges.filter((r) => r.tag === "ansi_red");
    assert.ok(dimRanges.length > 0, "Should detect dim text");
    assert.ok(redRanges.length > 0, "Should detect red text");

    // Verify that ranges properly track line numbers for multi-line content
    const firstRedRange = redRanges[0];
    assert.strictEqual(
      firstRedRange.range.start.line,
      1,
      "First red range should be on line 1",
    );

    if (redRanges.length > 1) {
      const secondRedRange = redRanges[1];
      assert.strictEqual(
        secondRedRange.range.start.line,
        2,
        "Second red range should be on line 2",
      );
    }
  });
});

// suite("Syntax Highlighting Integration Tests", () => {
//   setup(async () => {
//     // Close all editors
//     await vscode.commands.executeCommand("workbench.action.closeAllEditors");
//
//     // Reset the global terminal instance
//     resetForTesting();
//   });
//
//   teardown(async () => {
//     // Clean up after each test
//     await vscode.commands.executeCommand("workbench.action.closeAllEditors");
//   });
//
//   test("Semantic tokens are provided for terminal document with basic status", async () => {
//     // Create terminal
//     await vscode.commands.executeCommand("terminal-editor.reveal");
//
//     // Get the terminal editor
//     const activeEditor = vscode.window.activeTextEditor;
//     assert.ok(activeEditor);
//     assert.strictEqual(activeEditor.document.uri.scheme, "terminal-editor");
//
//     // Wait for sync to complete
//     await waitForSync();
//
//     // Verify the document has the expected basic content structure
//     const text = activeEditor.document.getText();
//     assert.ok(
//       text.includes("= ="),
//       "Document should contain basic status line",
//     );
//
//     // Find the line with the status
//     let statusLineIndex = -1;
//     for (let i = 0; i < activeEditor.document.lineCount; i++) {
//       if (activeEditor.document.lineAt(i).text === "= =") {
//         statusLineIndex = i;
//         break;
//       }
//     }
//     assert.ok(statusLineIndex >= 0, "Should find status line");
//
//     // Test that the extension correctly registers the semantic tokens provider
//     const provider = new TerminalSemanticTokensProvider();
//     const tokenResult = provider.provideDocumentSemanticTokens(
//       activeEditor.document,
//       {
//         isCancellationRequested: false,
//         onCancellationRequested: () => ({ dispose: () => {} }),
//       },
//     );
//
//     // Handle async result
//     const tokens = await Promise.resolve(tokenResult);
//     assert.ok(tokens, "Should provide semantic tokens");
//     if (tokens) {
//       assert.ok(tokens.data.length > 0, "Should have token data");
//
//       // Decode tokens with fixed logic and verify they correspond to correct text
//       const legend = TerminalSemanticTokensProvider.getLegend();
//       const decodedTokens = decodeSemanticTokens(
//         activeEditor.document,
//         tokens,
//         legend,
//       );
//
//       // Filter out invalid tokens
//       const validTokens = decodedTokens.filter((t) => t.tokenText.length > 0);
//
//       // Should have 2 punctuation tokens for "="
//       const punctuationTokens = validTokens.filter((t) =>
//         t.expectedType === "operator"
//       );
//       assert.strictEqual(
//         punctuationTokens.length,
//         2,
//         "Should have exactly 2 punctuation tokens",
//       );
//
//       // Both tokens should be on the status line and should contain "="
//       punctuationTokens.forEach((token, index) => {
//         assert.strictEqual(
//           token.tokenText,
//           "=",
//           `Punctuation token ${index} should be '='`,
//         );
//         assert.strictEqual(
//           token.length,
//           1,
//           `Punctuation token ${index} should have length 1`,
//         );
//         assert.strictEqual(
//           token.line,
//           statusLineIndex,
//           `Punctuation token ${index} should be on status line ${statusLineIndex}`,
//         );
//       });
//
//       // The two tokens should be at positions 0 and 2 in the "= =" line
//       assert.strictEqual(
//         punctuationTokens[0].character,
//         0,
//         "First '=' should be at character 0",
//       );
//       assert.strictEqual(
//         punctuationTokens[1].character,
//         2,
//         "Second '=' should be at character 2",
//       );
//     }
//   });
//
//   test("Semantic tokens include highlighting for completed command status", async () => {
//     // Create terminal
//     await vscode.commands.executeCommand("terminal-editor.reveal");
//
//     // Get the terminal editor
//     const activeEditor = vscode.window.activeTextEditor;
//     assert.ok(activeEditor);
//
//     // Insert and run a simple command
//     const command = fastCommand();
//     await assertEdit(activeEditor, (editBuilder) => {
//       editBuilder.replace(new vscode.Range(0, 0, 0, 0), command);
//     });
//
//     await vscode.commands.executeCommand("terminal-editor.run");
//     await wait();
//
//     // Verify the document has the expected content structure
//     const text = activeEditor.document.getText();
//     assert.ok(
//       text.includes("time:"),
//       "Document should contain time information",
//     );
//     assert.ok(
//       text.includes("status:"),
//       "Document should contain status information",
//     );
//
//     // Find the status line
//     let statusLineIndex = -1;
//     for (let i = 0; i < activeEditor.document.lineCount; i++) {
//       const lineText = activeEditor.document.lineAt(i).text;
//       if (lineText.includes("time:") && lineText.includes("status:")) {
//         statusLineIndex = i;
//         break;
//       }
//     }
//     assert.ok(
//       statusLineIndex >= 0,
//       "Should find status line with time and status",
//     );
//
//     // Test that the provider can generate tokens for this content
//     const provider = new TerminalSemanticTokensProvider();
//     const tokenResult = provider.provideDocumentSemanticTokens(
//       activeEditor.document,
//       {
//         isCancellationRequested: false,
//         onCancellationRequested: () => ({ dispose: () => {} }),
//       },
//     );
//
//     // Handle async result
//     const tokens = await Promise.resolve(tokenResult);
//     assert.ok(tokens, "Should provide semantic tokens");
//     if (tokens) {
//       assert.ok(tokens.data.length > 0, "Should have token data");
//
//       // Decode tokens and verify they correspond to correct text
//       const legend = TerminalSemanticTokensProvider.getLegend();
//       const decodedTokens = decodeSemanticTokens(
//         activeEditor.document,
//         tokens,
//         legend,
//       );
//
//       // Filter out invalid tokens
//       const validTokens = decodedTokens.filter((t) => t.tokenText.length > 0);
//       assert.ok(validTokens.length > 0, "Should have valid decoded tokens");
//
//       // Should have keyword tokens for "time:" and "status:"
//       const keywordTokens = validTokens.filter((t) =>
//         t.expectedType === "keyword" && t.line === statusLineIndex
//       );
//       assert.ok(
//         keywordTokens.length >= 2,
//         "Should have at least 2 keyword tokens on status line",
//       );
//
//       // Should have punctuation tokens for "="
//       const punctuationTokens = validTokens.filter((t) =>
//         t.expectedType === "operator" && t.line === statusLineIndex
//       );
//       assert.strictEqual(
//         punctuationTokens.length,
//         2,
//         "Should have exactly 2 punctuation tokens on status line",
//       );
//
//       // Should have number tokens for time and status values
//       const numberTokens = validTokens.filter((t) =>
//         t.expectedType === "number" && t.line === statusLineIndex
//       );
//       assert.ok(
//         numberTokens.length >= 2,
//         "Should have at least 2 number tokens on status line",
//       );
//     }
//   });
//
//   test("Semantic tokens update when terminal content changes", async () => {
//     // Create terminal
//     await vscode.commands.executeCommand("terminal-editor.reveal");
//
//     // Get the terminal editor
//     const activeEditor = vscode.window.activeTextEditor;
//     assert.ok(activeEditor);
//
//     // Get initial tokens (should just be basic status)
//     await waitForSync();
//     const provider = new TerminalSemanticTokensProvider();
//     const initialTokenResult = provider.provideDocumentSemanticTokens(
//       activeEditor.document,
//       {
//         isCancellationRequested: false,
//         onCancellationRequested: () => ({ dispose: () => {} }),
//       },
//     );
//
//     const initialTokens = await Promise.resolve(initialTokenResult);
//     assert.ok(initialTokens, "Should provide initial semantic tokens");
//     const initialTokenCount = initialTokens ? initialTokens.data.length : 0;
//
//     // Add and run a command
//     const command = fastCommand();
//     await assertEdit(activeEditor, (editBuilder) => {
//       editBuilder.replace(new vscode.Range(0, 0, 0, 0), command);
//     });
//
//     await vscode.commands.executeCommand("terminal-editor.run");
//     await wait();
//
//     // Get updated tokens
//     const updatedTokenResult = provider.provideDocumentSemanticTokens(
//       activeEditor.document,
//       {
//         isCancellationRequested: false,
//         onCancellationRequested: () => ({ dispose: () => {} }),
//       },
//     );
//
//     const updatedTokens = await Promise.resolve(updatedTokenResult);
//     assert.ok(updatedTokens, "Should provide updated semantic tokens");
//
//     if (updatedTokens) {
//       // Should have more tokens after running a command (time, status, etc.)
//       assert.ok(
//         updatedTokens.data.length > initialTokenCount,
//         `Should have more tokens after command (initial: ${initialTokenCount}, updated: ${updatedTokens.data.length})`,
//       );
//     }
//   });
//
//   test("Semantic tokens provider handles empty document gracefully", async () => {
//     // Create terminal
//     await vscode.commands.executeCommand("terminal-editor.reveal");
//
//     // Get the terminal editor
//     const activeEditor = vscode.window.activeTextEditor;
//     assert.ok(activeEditor);
//
//     // Clear the document completely
//     await assertEdit(activeEditor, (editBuilder) => {
//       const doc = activeEditor.document;
//       const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
//       editBuilder.delete(fullRange);
//     });
//
//     // Try to get semantic tokens from empty document
//     const provider = new TerminalSemanticTokensProvider();
//     const tokenResult = provider.provideDocumentSemanticTokens(
//       activeEditor.document,
//       {
//         isCancellationRequested: false,
//         onCancellationRequested: () => ({ dispose: () => {} }),
//       },
//     );
//
//     // Should not crash and should return some result
//     const tokens = await Promise.resolve(tokenResult);
//     assert.ok(
//       tokens !== null && tokens !== undefined,
//       "Should handle empty document without crashing",
//     );
//   });
// });
//
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
    vscode.workspace.getConfiguration = () =>
      ({
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
      await assertEdit(activeEditor, (editBuilder) => {
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
});
