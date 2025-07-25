import * as vscode from 'vscode';
import { TerminalHistory } from './terminal-history';

export class TerminalDecorations {
	private promptDecorationType?: vscode.TextEditorDecorationType;
	private autosuggestionDecorationType?: vscode.TextEditorDecorationType;

	constructor(private history: TerminalHistory) {
		this.createDecorationTypes();
	}

	private createDecorationTypes(): void {
		// Create decoration type for prompt background highlighting
		this.promptDecorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: new vscode.ThemeColor('editor.lineHighlightBackground'),
			isWholeLine: true,
			textDecoration: 'none'
		});

		// Create decoration type for autosuggestions
		this.autosuggestionDecorationType = vscode.window.createTextEditorDecorationType({
			textDecoration: 'none'
		});
	}

	updateAutosuggestionDecorations(editor: vscode.TextEditor): void {
		if (!this.autosuggestionDecorationType || editor.document.uri.scheme !== 'terminal-editor') {
			return;
		}

		const decorations: vscode.DecorationOptions[] = [];
		const text = editor.document.getText();
		const lines = text.split('\n');

		// Only show autosuggestions in command section (before first blank line)
		let inCommandSection = true;
		let lineNumber = 0;

		for (const line of lines) {
			if (inCommandSection && line.trim() === '') {
				inCommandSection = false;
				break;
			}

			if (inCommandSection && lineNumber === editor.selection.active.line) {
				// Get current line up to cursor position
				const cursorPosition = editor.selection.active.character;
				const currentInput = line.substring(0, cursorPosition).trim();

				// Only suggest for complete words (not partial typing)
				if (currentInput && cursorPosition === line.length) {
					const suggestion = this.history.findAutosuggestion(currentInput);
					if (suggestion) {
						const startPos = new vscode.Position(lineNumber, cursorPosition);
						const endPos = new vscode.Position(lineNumber, cursorPosition);
						const range = new vscode.Range(startPos, endPos);

						decorations.push({
							range,
							renderOptions: {
								after: {
									contentText: suggestion,
									color: new vscode.ThemeColor('editorGhostText.foreground')
								}
							}
						});
					}
				}
			}

			lineNumber++;
		}

		editor.setDecorations(this.autosuggestionDecorationType, decorations);
	}

	updatePromptDecorations(editor: vscode.TextEditor): void {
		if (!this.promptDecorationType || editor.document.uri.scheme !== 'terminal-editor') {
			return;
		}

		const decorations: vscode.DecorationOptions[] = [];
		const text = editor.document.getText();
		const lines = text.split('\n');

		// Find command lines (before first blank line)
		let lineNumber = 0;
		for (const line of lines) {
			if (line.trim() === '') {
				break; // Stop at first blank line
			}

			// Add decoration for this command line
			const range = new vscode.Range(lineNumber, 0, lineNumber, line.length);
			decorations.push({ range });
			lineNumber++;
		}

		// If no command lines but the document is empty or has only one line, highlight the first line
		if (decorations.length === 0 && lines.length <= 2) {
			const range = new vscode.Range(0, 0, 0, lines[0]?.length || 0);
			decorations.push({ range });
		}

		editor.setDecorations(this.promptDecorationType, decorations);
	}

	updateDecorations(editor: vscode.TextEditor): void {
		this.updatePromptDecorations(editor);
		this.updateAutosuggestionDecorations(editor);
	}

	dispose(): void {
		if (this.promptDecorationType) {
			this.promptDecorationType.dispose();
			this.promptDecorationType = undefined;
		}
		if (this.autosuggestionDecorationType) {
			this.autosuggestionDecorationType.dispose();
			this.autosuggestionDecorationType = undefined;
		}
	}
}