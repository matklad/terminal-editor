import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {

	console.log('Congratulations, your extension "terminal-editor" is now active!');

	const disposable = vscode.commands.registerCommand('terminal-editor.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from terminal-editor!');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
