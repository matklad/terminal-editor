import * as vscode from 'vscode';

let terminalProvider: TerminalProvider | undefined;

class TerminalProvider implements vscode.TextDocumentContentProvider {
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this._onDidChange.event;

	private content = 'hello world';

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.content;
	}

	updateContent(newContent: string) {
		this.content = newContent;
		this._onDidChange.fire(vscode.Uri.parse('terminal-editor:terminal'));
	}
}

export function activate(context: vscode.ExtensionContext) {
	terminalProvider = new TerminalProvider();
	
	let disposableProvider = vscode.workspace.registerTextDocumentContentProvider('terminal-editor', terminalProvider);
	
	let disposable = vscode.commands.registerCommand('terminal-editor.reveal', async () => {
		const terminalUri = vscode.Uri.parse('terminal-editor:terminal');
		
		// Check if the terminal is already open
		const existingEditor = vscode.window.visibleTextEditors.find(editor => 
			editor.document.uri.toString() === terminalUri.toString()
		);
		
		if (existingEditor) {
			// Terminal already open, just focus it
			await vscode.window.showTextDocument(existingEditor.document, existingEditor.viewColumn);
			return;
		}

		// Check if we have an active editor to determine splitting
		const activeEditor = vscode.window.activeTextEditor;
		let viewColumn = vscode.ViewColumn.Two;
		
		if (!activeEditor) {
			// No active editor, open in first column and then split
			viewColumn = vscode.ViewColumn.One;
		}
		
		// Open the terminal document
		const doc = await vscode.workspace.openTextDocument(terminalUri);
		await vscode.window.showTextDocument(doc, {
			viewColumn: viewColumn,
			preserveFocus: false
		});
	});

	context.subscriptions.push(disposableProvider, disposable);
}

export function deactivate() {}