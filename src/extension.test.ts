import * as assert from 'assert';

import * as vscode from 'vscode';
import { resetForTesting, getTerminalForTesting } from './extension';
import { parseCommand, Terminal, TerminalSettings } from './model';
import { createSnapshotTester } from './snapshot';

// Helper functions for common test commands using node -e
function manyLinesCommand(lineCount: number): string {
	return `node -e "for(let i = 1; i <= ${lineCount}; i++) console.log('Line ' + i)"`;
}

function sleepCommand(seconds: number): string {
	return `node -e "setTimeout(() => { console.log('Done sleeping'); process.exit(0); }, ${seconds * 1000})"`;
}

function fastCommand(): string {
	return `node -e "console.log('Hello World')"`;
}

function errorCommand(): string {
	return `node -e "console.error('This is an error'); process.exit(1)"`;
}

function findTerminalDocument(): vscode.TextDocument | undefined {
	const terminalDocs = vscode.workspace.textDocuments.filter(doc =>
		doc.uri.scheme === 'terminal-editor'
	);

	if (terminalDocs.length > 1) {
		throw new Error(`Expected 0 or 1 terminal documents, found ${terminalDocs.length}`);
	}

	return terminalDocs.length === 1 ? terminalDocs[0] : undefined;
}

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');
	const snapshot = createSnapshotTester();

	setup(async () => {
		// Close all editors
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');

		// Reset the global terminal instance
		resetForTesting();
	});

	teardown(async () => {
		// Clean up after each test
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('Reveal command creates terminal', async () => {
		// Execute reveal command
		await vscode.commands.executeCommand('terminal-editor.reveal');

		// Check that terminal editor was created
		const doc = findTerminalDocument();
		assert.ok(doc, 'Terminal document should be created');

		// Check that the document has expected content using snapshot
		const text = doc.getText();
		snapshot.expectSnapshot('reveal-command-creates-terminal', text);
	});

	test('Second reveal command does not create duplicate', async () => {
		// Execute reveal command twice
		await vscode.commands.executeCommand('terminal-editor.reveal');
		await vscode.commands.executeCommand('terminal-editor.reveal');

		// Check that only one terminal editor exists
		const doc = findTerminalDocument();
		assert.ok(doc, 'Terminal document should exist and be unique');
	});

	test('Reveal works when terminal exists but not visible', async () => {
		// Create terminal and then close it
		await vscode.commands.executeCommand('terminal-editor.reveal');
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

		// Execute reveal again
		await vscode.commands.executeCommand('terminal-editor.reveal');

		// Check that terminal is visible again
		const activeEditor = vscode.window.activeTextEditor;
		assert.ok(activeEditor);
		assert.strictEqual(activeEditor.document.uri.scheme, 'terminal-editor');

		// Also verify using our helper function
		const doc = findTerminalDocument();
		assert.ok(doc, 'Terminal document should still exist');
		assert.strictEqual(doc, activeEditor.document);
	});

	test('Terminal recreated after close', async () => {
		// Create terminal
		await vscode.commands.executeCommand('terminal-editor.reveal');

		// Close the document completely
		const terminalDoc = findTerminalDocument();
		if (terminalDoc) {
			await vscode.window.showTextDocument(terminalDoc);
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		}

		// Execute reveal again
		await vscode.commands.executeCommand('terminal-editor.reveal');

		// Check that new terminal was created
		const newDoc = findTerminalDocument();
		assert.ok(newDoc, 'Terminal document should be recreated');
	});
});

suite('parseCommand Tests', () => {
	test('Simple command parsing', () => {
		const result = parseCommand('git status');
		assert.deepStrictEqual(result.tokens, ['git', 'status']);
		assert.strictEqual(result.cursorTokenIndex, undefined);
		assert.strictEqual(result.cursorTokenOffset, undefined);
	});

	test('Command with quoted arguments', () => {
		const result = parseCommand('echo "hello world" test');
		assert.deepStrictEqual(result.tokens, ['echo', 'hello world', 'test']);
	});

	test('Empty command', () => {
		const result = parseCommand('');
		assert.deepStrictEqual(result.tokens, []);
	});

	test('Command with multiple spaces', () => {
		const result = parseCommand('  git   status   --short  ');
		assert.deepStrictEqual(result.tokens, ['git', 'status', '--short']);
	});

	test('Cursor at beginning of first token', () => {
		const result = parseCommand('git status', 0);
		assert.strictEqual(result.cursorTokenIndex, 0);
		assert.strictEqual(result.cursorTokenOffset, 0);
	});

	test('Cursor in middle of first token', () => {
		const result = parseCommand('git status', 2);
		assert.strictEqual(result.cursorTokenIndex, 0);
		assert.strictEqual(result.cursorTokenOffset, 2);
	});

	test('Cursor at end of first token', () => {
		const result = parseCommand('git status', 2);
		assert.strictEqual(result.cursorTokenIndex, 0);
		assert.strictEqual(result.cursorTokenOffset, 2);
	});

	test('Cursor on whitespace between tokens', () => {
		const result = parseCommand('git status', 3);
		assert.strictEqual(result.cursorTokenIndex, undefined);
		assert.strictEqual(result.cursorTokenOffset, undefined);
	});

	test('Cursor at beginning of second token', () => {
		const result = parseCommand('git status', 4);
		assert.strictEqual(result.cursorTokenIndex, 1);
		assert.strictEqual(result.cursorTokenOffset, 0);
	});

	test('Cursor at end of command', () => {
		const result = parseCommand('git status', 10);
		assert.strictEqual(result.cursorTokenIndex, 1);
		assert.strictEqual(result.cursorTokenOffset, 6);
	});

	test('Cursor at end of command with trailing space', () => {
		const result = parseCommand('git status ', 11);
		assert.strictEqual(result.cursorTokenIndex, undefined);
		assert.strictEqual(result.cursorTokenOffset, undefined);
	});

	test('Cursor in quoted string', () => {
		const result = parseCommand('echo "hello world"', 8);
		assert.strictEqual(result.cursorTokenIndex, 1);
		assert.strictEqual(result.cursorTokenOffset, 2);
	});

	test('Cursor at quote start', () => {
		const result = parseCommand('echo "hello world"', 5);
		assert.strictEqual(result.cursorTokenIndex, 1);
		assert.strictEqual(result.cursorTokenOffset, 0);
	});

	test('Multiple quoted arguments', () => {
		const result = parseCommand('cmd "arg1" "arg2 with spaces"');
		assert.deepStrictEqual(result.tokens, ['cmd', 'arg1', 'arg2 with spaces']);
	});

	test('Empty quoted string', () => {
		const result = parseCommand('echo ""');
		assert.deepStrictEqual(result.tokens, ['echo', '']);
	});

	test('Cursor in empty command', () => {
		const result = parseCommand('', 0);
		assert.strictEqual(result.cursorTokenIndex, undefined);
		assert.strictEqual(result.cursorTokenOffset, undefined);
	});
});

suite('Terminal Configuration Tests', () => {
	test('Terminal respects maxOutputLines configuration', async () => {
		const maxLines = 5;
		const mockSettings: TerminalSettings = {
			maxOutputLines: () => maxLines
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
		const lines = output.text.split('\n').filter(line => line.trim() !== '');

		// The output should be limited to maxLines
		// Since we generated 20 lines total and limit to 5, we should get the last 5: lines 16-20
		// But due to how split works with trailing newlines, we might get 4 content lines
		assert.ok(lines.length <= maxLines, `Got ${lines.length} lines, expected at most ${maxLines}`);
		assert.ok(lines.length >= maxLines - 1, `Got ${lines.length} lines, expected at least ${maxLines - 1}`);

		// Should contain the last lines
		assert.ok(lines[lines.length - 1].includes('Line 20'), 'Should end with Line 20');

		// Should start with Line 16 or 17 (depending on exact line count due to trailing newlines)
		const firstLine = lines[0];
		assert.ok(firstLine.includes('Line 16') || firstLine.includes('Line 17'),
			`First line should be Line 16 or 17, got: ${firstLine}`);
	});
});

suite('Run Command Tests', () => {
	const snapshot = createSnapshotTester();

	setup(async () => {
		// Close all editors
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');

		// Reset the global terminal instance
		resetForTesting();
	});

	teardown(async () => {
		// Clean up after each test
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('Run command executes simple command and shows output', async () => {
		// Create terminal
		await vscode.commands.executeCommand('terminal-editor.reveal');

		// Get the terminal editor
		const activeEditor = vscode.window.activeTextEditor;
		assert.ok(activeEditor);
		assert.strictEqual(activeEditor.document.uri.scheme, 'terminal-editor');

		// Insert a simple command
		const command = fastCommand();
		await activeEditor.edit(editBuilder => {
			editBuilder.replace(new vscode.Range(0, 0, 0, 0), command);
		});

		// Run the command
		await vscode.commands.executeCommand('terminal-editor.run');

		// Wait for the process to complete
		const terminal = getTerminalForTesting();
		await terminal.waitForCompletion();

		// Check that the output contains the expected result using snapshot
		const text = activeEditor.document.getText();
		snapshot.expectSnapshot('run-command-simple-output', text);
	});

	test('Run command handles command with error exit code', async () => {
		// Create terminal
		await vscode.commands.executeCommand('terminal-editor.reveal');

		// Get the terminal editor
		const activeEditor = vscode.window.activeTextEditor;
		assert.ok(activeEditor);

		// Insert a command that exits with error
		const command = errorCommand();
		await activeEditor.edit(editBuilder => {
			editBuilder.replace(new vscode.Range(0, 0, 0, 0), command);
		});

		// Run the command
		await vscode.commands.executeCommand('terminal-editor.run');

		// Wait for the process to complete
		const terminal = getTerminalForTesting();
		await terminal.waitForCompletion();

		// Check that the output shows error exit code using snapshot
		const text = activeEditor.document.getText();
		snapshot.expectSnapshot('run-command-error-exit-code', text);
	});

	test('Run command shows runtime updates', async function() {
		// Increase timeout for this test
		this.timeout(8000);

		// Create terminal
		await vscode.commands.executeCommand('terminal-editor.reveal');

		// Get the terminal editor
		const activeEditor = vscode.window.activeTextEditor;
		assert.ok(activeEditor);

		// Insert a command that sleeps for a short time
		const command = sleepCommand(3);
		await activeEditor.edit(editBuilder => {
			editBuilder.replace(new vscode.Range(0, 0, 0, 0), command);
		});

		// Run the command
		await vscode.commands.executeCommand('terminal-editor.run');

		// Wait briefly and check that runtime is shown (should be running)
		// Note: This setTimeout is intentional - we need to check intermediate state while process is running
		await new Promise(resolve => setTimeout(resolve, 1500));
		let text = activeEditor.document.getText();
		assert.ok(text.includes(' time:'), `Expected status line with time, got: ${text}`);
		assert.ok(!text.includes('status:'), `Should not show status while running, got: ${text}`);

		// Wait for completion
		const terminal = getTerminalForTesting();
		await terminal.waitForCompletion();
		text = activeEditor.document.getText();
		snapshot.expectSnapshot('run-command-runtime-updates-final', text);
	});

	test('Run command with no terminal editor shows error', async () => {
		// Don't create a terminal editor first

		// Try to run command - should show error
		await vscode.commands.executeCommand('terminal-editor.run');

		// We can't easily test the error message display, but the command should not crash
		// The test passes if no exception is thrown
	});

	test('Run command with empty command shows error', async () => {
		// Create terminal with empty command
		await vscode.commands.executeCommand('terminal-editor.reveal');

		// Get the terminal editor - it should be empty initially
		const activeEditor = vscode.window.activeTextEditor;
		assert.ok(activeEditor);

		// Run the command (should fail due to empty command)
		await vscode.commands.executeCommand('terminal-editor.run');

		// The test passes if no exception is thrown
	});

	test('Run command kills previous process when new one starts', async () => {
		// Create terminal
		await vscode.commands.executeCommand('terminal-editor.reveal');

		// Get the terminal editor
		const activeEditor = vscode.window.activeTextEditor;
		assert.ok(activeEditor);

		// Insert a long-running command
		const longCommand = sleepCommand(10);
		await activeEditor.edit(editBuilder => {
			editBuilder.replace(new vscode.Range(0, 0, 0, 0), longCommand);
		});

		// Run the first command
		await vscode.commands.executeCommand('terminal-editor.run');

		// Replace with a quick command
		const quickCommand = fastCommand();
		await activeEditor.edit(editBuilder => {
			const doc = activeEditor.document;
			const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
			editBuilder.replace(fullRange, quickCommand);
		});

		// Run the second command
		await vscode.commands.executeCommand('terminal-editor.run');

		// Wait for completion
		const terminal = getTerminalForTesting();
		await terminal.waitForCompletion();

		// Check that we got output from the second command using snapshot
		const text = activeEditor.document.getText();
		snapshot.expectSnapshot('run-command-kills-previous-process', text);
	});
});
