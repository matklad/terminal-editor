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
});