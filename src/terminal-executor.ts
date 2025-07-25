import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { TerminalFileSystemProvider } from './terminal-filesystem';
import { TerminalHistory } from './terminal-history';

const MAX_OUTPUT_SIZE = 128 * 1024; // 128KiB limit

export class TerminalExecutor {
	constructor(
		private terminalProvider: TerminalFileSystemProvider,
		private history: TerminalHistory
	) {}

	async executeCommand(terminalEditor: vscode.TextEditor): Promise<void> {
		const content = terminalEditor.document.getText();
		const lines = content.split('\n');

		// Find the first blank line to determine command boundary
		const commandLines: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trim() === '') {
				break;
			}
			commandLines.push(lines[i]);
		}

		if (commandLines.length === 0 || commandLines.join('').trim() === '') {
			vscode.window.showErrorMessage('No command to execute');
			return;
		}

		// Join all command lines with spaces (multiline commands)
		const commandLine = commandLines.join(' ').trim();
		const commandParts = commandLine.split(/\s+/);
		const command = commandParts[0];
		const args = commandParts.slice(1);

		// Add command to history
		this.history.addCommand(commandLine);

		// Use workspace root as current working directory, fallback to process.cwd() for tests
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

		// Track timing for the command execution
		const startTime = Date.now();
		let timingInterval: NodeJS.Timeout | undefined;

		const childProcess = spawn(command, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			shell: false,
			cwd: workspaceRoot
		});

		// Logical buffers for output management
		let stdoutData = '';
		let stderrData = '';
		let isComplete = false;
		let exitCode = 0;

		// Function to format elapsed time
		const formatElapsedTime = (milliseconds: number): string => {
			const seconds = Math.floor(milliseconds / 1000);
			const minutes = Math.floor(seconds / 60);
			const hours = Math.floor(minutes / 60);

			const s = seconds % 60;
			const m = minutes % 60;
			const h = hours;

			if (h > 0) {
				return `${h}h ${m}m ${s}s`;
			} else if (m > 0) {
				return `${m}m ${s}s`;
			} else {
				return `${s}s`;
			}
		};

		// Function to materialize the complete terminal content
		const updateTerminalContent = () => {
			const elapsed = Date.now() - startTime;
			const timeStr = formatElapsedTime(elapsed);

			let content = commandLines.join('\n') + '\n\n';

			// Add stdout (truncated if necessary)
			if (stdoutData) {
				let stdout = stdoutData;
				if (stdout.length > MAX_OUTPUT_SIZE) {
					stdout = stdout.substring(0, MAX_OUTPUT_SIZE) + '\n... (output truncated)\n';
				}
				content += stdout;
			}

			// Add stderr (truncated if necessary)
			if (stderrData) {
				let stderr = stderrData;
				if (stderr.length > MAX_OUTPUT_SIZE) {
					stderr = stderr.substring(0, MAX_OUTPUT_SIZE) + '\n... (stderr truncated)\n';
				}
				content += stderr;
			}

			// Add timing information
			if (isComplete) {
				// Final status line
				const statusLine = exitCode === 0 ? `${timeStr} ok` : `${timeStr} !${exitCode}`;
				content += '\n' + statusLine + '\n';
			} else {
				const statusLine = `${timeStr}`;
				content += '\n' + statusLine + '\n';
			}

			this.terminalProvider.updateContent(content);
		};

		timingInterval = setInterval(() => {
			if (!isComplete) {
				updateTerminalContent();
			}
		}, 1000);

		childProcess.stdout.on('data', (data: Buffer) => {
			stdoutData += data.toString();
			updateTerminalContent();
		});

		childProcess.stderr.on('data', (data: Buffer) => {
			stderrData += data.toString();
			updateTerminalContent();
		});

		childProcess.on('close', (code) => {
			// Clear the timing interval
			if (timingInterval) {
				clearInterval(timingInterval);
			}

			isComplete = true;
			exitCode = code || 0;
			updateTerminalContent();
		});

		childProcess.on('error', (error) => {
			// Clear the timing interval on error
			if (timingInterval) {
				clearInterval(timingInterval);
			}

			stderrData += `Error: ${error.message}\n`;
			isComplete = true;
			exitCode = 1;
			updateTerminalContent();
		});
	}
}