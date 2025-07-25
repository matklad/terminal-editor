import * as vscode from 'vscode';
import { TerminalFileSystemProvider } from './terminal-filesystem';
import { TerminalSemanticTokensProvider } from './terminal-tokens';
import { TerminalCompletionProvider } from './terminal-completion';
import { TerminalDefinitionProvider } from './terminal-definition';
import { TerminalExecutor } from './terminal-executor';
import { TerminalHistory } from './terminal-history';
import { TerminalDecorations } from './terminal-decorations';

let terminalProvider: TerminalFileSystemProvider | undefined;
let terminalExecutor: TerminalExecutor | undefined;
let terminalHistory: TerminalHistory | undefined;
let terminalDecorations: TerminalDecorations | undefined;

export function activate(extensionContext: vscode.ExtensionContext) {
	// Initialize core components
	terminalHistory = new TerminalHistory(extensionContext);
	terminalProvider = new TerminalFileSystemProvider();
	terminalExecutor = new TerminalExecutor(
		terminalProvider,
		terminalHistory
	);
	terminalDecorations = new TerminalDecorations(terminalHistory);

	// Register the file system provider to enable editing
	const disposableProvider = vscode.workspace.registerFileSystemProvider('terminal-editor', terminalProvider);

	// Register semantic tokens provider for syntax highlighting
	const legend = new vscode.SemanticTokensLegend(
		['function', 'variable', 'string', 'parameter', 'property', 'keyword'],
		['bold', 'italic']
	);
	const semanticProvider = new TerminalSemanticTokensProvider();
	const disposableSemanticProvider = vscode.languages.registerDocumentSemanticTokensProvider(
		{ scheme: 'terminal-editor' },
		semanticProvider,
		legend
	);

	// Register completion provider for path completion
	const completionProvider = new TerminalCompletionProvider(terminalHistory.getHistory());
	const disposableCompletionProvider = vscode.languages.registerCompletionItemProvider(
		{ scheme: 'terminal-editor' },
		completionProvider,
		'/', '.' // Trigger completion on / and .
	);

	// Register definition provider for goto definition on error paths
	const definitionProvider = new TerminalDefinitionProvider();
	const disposableDefinitionProvider = vscode.languages.registerDefinitionProvider(
		{ scheme: 'terminal-editor' },
		definitionProvider
	);

	// Register event listeners for decorations
	const disposableActiveEditorChange = vscode.window.onDidChangeActiveTextEditor(editor => {
		if (editor && terminalDecorations) {
			terminalDecorations.updateDecorations(editor);
		}
	});

	const disposableTextDocumentChange = vscode.workspace.onDidChangeTextDocument(event => {
		if (event.document.uri.scheme === 'terminal-editor' && terminalDecorations) {
			const editor = vscode.window.visibleTextEditors.find(e => e.document === event.document);
			if (editor) {
				terminalDecorations.updateDecorations(editor);
			}
		}
	});

	const disposableSelectionChange = vscode.window.onDidChangeTextEditorSelection(event => {
		if (event.textEditor.document.uri.scheme === 'terminal-editor' && terminalDecorations) {
			terminalDecorations.updateAutosuggestionDecorations(event.textEditor);
		}
	});

	// Update decorations for any already open terminal editors
	vscode.window.visibleTextEditors.forEach(editor => {
		if (editor.document.uri.scheme === 'terminal-editor' && terminalDecorations) {
			terminalDecorations.updateDecorations(editor);
		}
	});

	// Register commands
	const revealCommand = vscode.commands.registerCommand('terminal-editor.reveal', async () => {
		const terminalUri = vscode.Uri.parse('terminal-editor:/terminal');

		// Check if the terminal is already open
		const existingEditor = vscode.window.visibleTextEditors.find(editor =>
			editor.document.uri.toString() === terminalUri.toString()
		);

		if (existingEditor && terminalExecutor) {
			// Execute the current command in the terminal, without focusing it.
			await terminalExecutor.executeCommand(existingEditor);
			return;
		}

		// Check if we have an active editor to determine splitting
		const activeEditor = vscode.window.activeTextEditor;

		if (activeEditor && activeEditor.viewColumn === vscode.ViewColumn.One) {
			// Move the active editor to the right pane to make room for terminal on the left
			await vscode.window.showTextDocument(activeEditor.document, {
				viewColumn: vscode.ViewColumn.Two,
				preserveFocus: true
			});
		}

		// Always open terminal in the left pane (column one)
		const doc = await vscode.workspace.openTextDocument(terminalUri);
		const editor = await vscode.window.showTextDocument(doc, {
			viewColumn: vscode.ViewColumn.One,
			preserveFocus: false
		});

		// Update decorations for the newly opened terminal
		if (terminalDecorations) {
			terminalDecorations.updateDecorations(editor);
		}
	});

	const executeCommand = vscode.commands.registerCommand('terminal-editor.execute', async () => {
		const terminalUri = vscode.Uri.parse('terminal-editor:/terminal');
		const terminalEditor = vscode.window.visibleTextEditors.find(editor =>
			editor.document.uri.toString() === terminalUri.toString()
		);

		if (!terminalEditor) {
			vscode.window.showErrorMessage('No terminal');
			return;
		}

		if (!terminalExecutor) {
			vscode.window.showErrorMessage('Terminal executor not initialized');
			return;
		}

		await terminalExecutor.executeCommand(terminalEditor);
	});

	const acceptSuggestionWordCommand = vscode.commands.registerCommand('terminal-editor.acceptSuggestionWord', async () => {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor || activeEditor.document.uri.scheme !== 'terminal-editor') {
			// Not in terminal editor, do default behavior
			await vscode.commands.executeCommand('cursorRight');
			return;
		}

		// Check if we're in command section
		const text = activeEditor.document.getText();
		const lines = text.split('\n');
		const currentLine = activeEditor.selection.active.line;

		let inCommandSection = true;
		for (let i = 0; i < currentLine; i++) {
			if (lines[i].trim() === '') {
				inCommandSection = false;
				break;
			}
		}

		if (!inCommandSection) {
			// Not in command section, do default behavior
			await vscode.commands.executeCommand('cursorRight');
			return;
		}

		// Get current line and cursor position
		const line = lines[currentLine];
		const cursorPosition = activeEditor.selection.active.character;

		// Only suggest if cursor is at end of line
		if (cursorPosition !== line.length) {
			await vscode.commands.executeCommand('cursorRight');
			return;
		}

		const currentInput = line.trim();

		// Find suggestion
		const suggestion = terminalHistory?.findAutosuggestion(currentInput);
		if (suggestion) {
			// Accept only the first word from the suggestion
			const firstWord = suggestion.match(/^\s*\S+/)?.[0] || suggestion;
			
			const success = await activeEditor.edit(editBuilder => {
				const position = new vscode.Position(currentLine, cursorPosition);
				editBuilder.insert(position, firstWord);
			});

			if (success) {
				// Move cursor to end of inserted word
				const newPosition = new vscode.Position(currentLine, cursorPosition + firstWord.length);
				activeEditor.selection = new vscode.Selection(newPosition, newPosition);
			}
		} else {
			// No suggestion, do default behavior
			await vscode.commands.executeCommand('cursorRight');
		}
	});

	const acceptSuggestionCommand = vscode.commands.registerCommand('terminal-editor.acceptSuggestion', async () => {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor || activeEditor.document.uri.scheme !== 'terminal-editor') {
			// Not in terminal editor, do default behavior
			await vscode.commands.executeCommand('cursorEnd');
			return;
		}

		// Check if we're in command section
		const text = activeEditor.document.getText();
		const lines = text.split('\n');
		const currentLine = activeEditor.selection.active.line;

		let inCommandSection = true;
		for (let i = 0; i < currentLine; i++) {
			if (lines[i].trim() === '') {
				inCommandSection = false;
				break;
			}
		}

		if (!inCommandSection) {
			// Not in command section, do default behavior
			await vscode.commands.executeCommand('cursorEnd');
			return;
		}

		// Get current line and cursor position
		const line = lines[currentLine];
		const cursorPosition = activeEditor.selection.active.character;

		// Only suggest if cursor is at end of line
		if (cursorPosition !== line.length) {
			await vscode.commands.executeCommand('cursorEnd');
			return;
		}

		const currentInput = line.trim();

		// Find suggestion
		const suggestion = terminalHistory?.findAutosuggestion(currentInput);
		if (suggestion) {
			// Insert the entire suggestion
			const success = await activeEditor.edit(editBuilder => {
				const position = new vscode.Position(currentLine, cursorPosition);
				editBuilder.insert(position, suggestion);
			});

			if (success) {
				// Move cursor to end of inserted text
				const newPosition = new vscode.Position(currentLine, cursorPosition + suggestion.length);
				activeEditor.selection = new vscode.Selection(newPosition, newPosition);
			}
		} else {
			// No suggestion, do default behavior
			await vscode.commands.executeCommand('cursorEnd');
		}
	});

	extensionContext.subscriptions.push(
		disposableProvider,
		disposableSemanticProvider,
		disposableCompletionProvider,
		disposableDefinitionProvider,
		disposableActiveEditorChange,
		disposableTextDocumentChange,
		disposableSelectionChange,
		revealCommand,
		executeCommand,
		acceptSuggestionWordCommand,
		acceptSuggestionCommand
	);
}

export function deactivate() {
	if (terminalDecorations) {
		terminalDecorations.dispose();
		terminalDecorations = undefined;
	}
}