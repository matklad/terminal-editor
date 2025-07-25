import * as vscode from 'vscode';

const HISTORY_KEY = 'terminalEditor.commandHistory';
const MAX_HISTORY_SIZE = 128;

export class TerminalHistory {
	private commandHistory: string[] = [];

	constructor(private context: vscode.ExtensionContext) {
		this.loadHistory();
	}

	private loadHistory(): void {
		const savedHistory = this.context.globalState.get<string[]>(HISTORY_KEY, []);
		this.commandHistory = savedHistory.slice(-MAX_HISTORY_SIZE); // Keep only last 128 items
	}

	saveHistory(): void {
		this.context.globalState.update(HISTORY_KEY, this.commandHistory);
	}

	addCommand(command: string): void {
		if (command && (!this.commandHistory.length || this.commandHistory[this.commandHistory.length - 1] !== command)) {
			this.commandHistory.push(command);
			// Keep history limited to MAX_HISTORY_SIZE commands
			if (this.commandHistory.length > MAX_HISTORY_SIZE) {
				this.commandHistory.shift();
			}
			this.saveHistory();
		}
	}

	getHistory(): string[] {
		return this.commandHistory;
	}

	findAutosuggestion(currentInput: string): string | undefined {
		if (!currentInput.trim()) {
			return undefined;
		}

		// Find the most recent command that starts with the current input
		for (const historyCommand of this.commandHistory.slice().reverse()) {
			if (historyCommand !== currentInput && historyCommand.startsWith(currentInput)) {
				return historyCommand.substring(currentInput.length);
			}
		}

		return undefined;
	}
}