import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {

	console.log('Congratulations, your extension "terminal-editor" is now active!');

	const revealCommand = vscode.commands.registerCommand('terminal-editor.reveal', reveal);
	const runCommand = vscode.commands.registerCommand('terminal-editor.run', run);
	const dwimCommand = vscode.commands.registerCommand('terminal-editor.dwim', dwim);

	context.subscriptions.push(revealCommand, runCommand, dwimCommand);
}

export function deactivate() {}

function reveal() {
	vscode.window.showInformationMessage('Terminal Editor: Reveal command executed!');
}

function run() {
	vscode.window.showInformationMessage('Terminal Editor: Run command executed!');
}

function dwim() {
	vscode.window.showInformationMessage('Terminal Editor: Do What I Mean command executed!');
}
