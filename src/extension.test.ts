import * as assert from 'assert';

import * as vscode from 'vscode';
import { resetForTesting } from './extension';

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
		assert.ok(text.includes('hello world'));
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
