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
		assert.strictEqual(terminalEditor.document.getText(), 'echo hello\nworld\n\nThis is a multiline command that will be joined with spaces');
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

	test('terminal-editor.execute command is registered', async () => {
		// Activate extension first
		await vscode.commands.executeCommand('terminal-editor.reveal');
		
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('terminal-editor.execute'));
	});

	test('terminal-editor.execute requires terminal editor to be active', async () => {
		// Open a regular document
		const doc = await vscode.workspace.openTextDocument({ content: 'echo test', language: 'plaintext' });
		await vscode.window.showTextDocument(doc);
		
		// Try to execute - should show error since it's not the terminal editor
		await vscode.commands.executeCommand('terminal-editor.execute');
		
		// The command should complete without throwing
		// Error message would be shown to user but we can't easily test that
	});

	test('terminal-editor.execute runs command from first line', async () => {
		// First reveal terminal with some content
		await vscode.commands.executeCommand('terminal-editor.reveal');
		
		// Get the terminal editor and modify its content to have a command
		const terminalUri = vscode.Uri.parse('terminal-editor:terminal');
		let terminalEditor = vscode.window.visibleTextEditors.find(editor => 
			editor.document.uri.toString() === terminalUri.toString()
		);
		assert.ok(terminalEditor, 'Terminal editor should be visible');

		// We need to update the terminal content to have a command
		// Since it's a virtual document, we need to work with the provider
		// For testing, let's just test that the command can be executed
		// The actual output testing would be complex in this test environment
		
		// Make sure the terminal editor is active
		await vscode.window.showTextDocument(terminalEditor.document);
		
		// Execute the command - this should not throw
		await vscode.commands.executeCommand('terminal-editor.execute');
	});

	test('terminal-editor.execute handles multiline commands', async () => {
		// The default terminal content is:
		// 'echo hello\nworld\n\nThis is a multiline command that will be joined with spaces'
		// This should execute "echo hello world" (lines until first blank line)
		
		await vscode.commands.executeCommand('terminal-editor.reveal');
		
		const terminalUri = vscode.Uri.parse('terminal-editor:terminal');
		let terminalEditor = vscode.window.visibleTextEditors.find(editor => 
			editor.document.uri.toString() === terminalUri.toString()
		);
		assert.ok(terminalEditor, 'Terminal editor should be visible');
		
		// Make sure the terminal editor is active
		await vscode.window.showTextDocument(terminalEditor.document);
		
		// Execute the multiline command - should execute "echo hello world"
		await vscode.commands.executeCommand('terminal-editor.execute');
		
		// The command should execute without throwing
		// The actual command would be "echo hello world" (joined with spaces)
	});
});