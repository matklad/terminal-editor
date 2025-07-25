import * as vscode from 'vscode';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

export class TerminalCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private commandHistory: string[]) {}

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		context: vscode.CompletionContext
	): Promise<vscode.CompletionItem[]> {
		const completions: vscode.CompletionItem[] = [];

		// Get the current line and check if we're in command section
		const text = document.getText();
		const lines = text.split('\n');
		let inCommandSection = true;
		for (let i = 0; i < position.line; i++) {
			if (lines[i].trim() === '') {
				inCommandSection = false;
				break;
			}
		}

		// Only provide suggestions in command section
		if (!inCommandSection) {
			return completions;
		}

		// Get the current line and word being typed
		const line = document.lineAt(position.line);
		const wordRange = document.getWordRangeAtPosition(position, /[^\s]+/);
		const word = wordRange ? document.getText(wordRange) : '';
		const lineStart = line.text.substring(0, position.character);
		const parts = lineStart.trim().split(/\s+/);

		// If we're at the beginning of a line (first word), provide command history suggestions
		if (parts.length <= 1 || (parts.length === 1 && word === parts[0])) {
			// Get history suggestions
			const currentInput = parts[0] || '';
			for (const historyCommand of this.commandHistory.slice().reverse()) { // Most recent first
				if (historyCommand !== currentInput && historyCommand.startsWith(currentInput)) {
					const completion = new vscode.CompletionItem(
						historyCommand,
						vscode.CompletionItemKind.Text
					);
					completion.detail = 'from history';
					completions.push(completion);

					// Limit to top 10 history suggestions
					if (completions.length >= 10) {
						break;
					}
				}
			}

			// If this is just the first word being typed, return only history completions
			if (parts.length <= 1) {
				return completions;
			}
		}

		try {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!workspaceRoot) {
				return completions;
			}

			// Determine the directory to search in
			let searchDir = workspaceRoot;
			let prefix = word;

			if (word.includes('/')) {
				const lastSlash = word.lastIndexOf('/');
				const dirPart = word.substring(0, lastSlash);
				prefix = word.substring(lastSlash + 1);

				// Handle relative paths
				if (dirPart.startsWith('./')) {
					searchDir = join(workspaceRoot, dirPart.substring(2));
				} else if (dirPart.startsWith('/')) {
					searchDir = dirPart;
				} else {
					searchDir = join(workspaceRoot, dirPart);
				}
			}

			// Check if directory exists
			if (!existsSync(searchDir)) {
				return completions;
			}

			// Read directory contents
			const entries = readdirSync(searchDir, { withFileTypes: true });

			for (const entry of entries) {
				if (entry.name.startsWith(prefix) || prefix === '') {
					const completion = new vscode.CompletionItem(
						entry.name,
						entry.isDirectory() ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
					);

					// For directories, add trailing slash
					if (entry.isDirectory()) {
						completion.insertText = entry.name + '/';
					}

					completions.push(completion);
				}
			}
		} catch (error) {
			// Ignore errors and return empty completions
		}

		return completions;
	}
}