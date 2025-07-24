import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('terminal-editor.reveal command can be executed', async () => {
		await vscode.commands.executeCommand('terminal-editor.reveal');
	});

	test('terminal-editor.reveal command is registered after activation', async () => {
		await vscode.commands.executeCommand('terminal-editor.reveal');
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('terminal-editor.reveal'));
	});

	test('terminal-editor.reveal opens terminal document', async () => {
		await vscode.commands.executeCommand('terminal-editor.reveal');
		
		// Check that the terminal document is now open
		const terminalUri = vscode.Uri.parse('terminal-editor:terminal');
		const terminalEditor = vscode.window.visibleTextEditors.find(editor => 
			editor.document.uri.toString() === terminalUri.toString()
		);
		
		assert.ok(terminalEditor, 'Terminal editor should be visible');
		assert.strictEqual(terminalEditor.document.getText(), 'hello world');
	});

	test('terminal-editor.reveal is singleton', async () => {
		// Execute reveal twice
		await vscode.commands.executeCommand('terminal-editor.reveal');
		await vscode.commands.executeCommand('terminal-editor.reveal');
		
		// Should only have one terminal editor
		const terminalUri = vscode.Uri.parse('terminal-editor:terminal');
		const terminalEditors = vscode.window.visibleTextEditors.filter(editor => 
			editor.document.uri.toString() === terminalUri.toString()
		);
		
		assert.strictEqual(terminalEditors.length, 1, 'Should only have one terminal editor');
	});

	test('terminal-editor.reveal opens in second column when editor exists', async () => {
		// First open a regular document
		const doc = await vscode.workspace.openTextDocument({ content: 'test', language: 'plaintext' });
		await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
		
		// Then reveal terminal
		await vscode.commands.executeCommand('terminal-editor.reveal');
		
		// Check that terminal is in second column
		const terminalUri = vscode.Uri.parse('terminal-editor:terminal');
		const terminalEditor = vscode.window.visibleTextEditors.find(editor => 
			editor.document.uri.toString() === terminalUri.toString()
		);
		
		assert.ok(terminalEditor, 'Terminal editor should be visible');
		assert.strictEqual(terminalEditor.viewColumn, vscode.ViewColumn.Two);
	});
});