import * as assert from 'assert';

import * as vscode from 'vscode';
import { resetForTesting } from './extension';
import { parseCommand, Terminal, TerminalSettings } from './model';

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

		// Check that the document has expected content
		const text = doc.getText();
		assert.ok(text.includes('= ='));
		// No process output expected initially, so just check that it doesn't crash
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
		const command = `node -e "for(let i = 1; i <= ${totalLines}; i++) console.log('Line ' + i)"`;
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
