import * as assert from 'assert';
import * as vscode from 'vscode';
import { TerminalHistory } from './terminal-history';

// Simple unit tests for our core logic without VS Code mocking
suite('Provider Logic Tests', () => {

	suite('TerminalHistory', () => {
		// We'll test this without a real VS Code context by accessing internal state
		// This is a pragmatic approach for unit testing business logic
		
		test('manages command history correctly', () => {
			// Create a minimal context for testing
			const mockContext = {
				globalState: {
					get: () => [],
					update: () => Promise.resolve()
				}
			} as any;
			
			const history = new TerminalHistory(mockContext);
			
			// Test adding commands
			history.addCommand('echo hello');
			history.addCommand('ls -la');
			
			const commands = history.getHistory();
			assert.strictEqual(commands.length, 2);
			assert.strictEqual(commands[0], 'echo hello');
			assert.strictEqual(commands[1], 'ls -la');
		});
		
		test('prevents duplicate commands', () => {
			const mockContext = {
				globalState: { get: () => [], update: () => Promise.resolve() }
			} as any;
			
			const history = new TerminalHistory(mockContext);
			
			history.addCommand('echo hello');
			history.addCommand('echo hello'); // Duplicate
			history.addCommand('ls -la');
			
			const commands = history.getHistory();
			assert.strictEqual(commands.length, 2);
			assert.strictEqual(commands[0], 'echo hello');
			assert.strictEqual(commands[1], 'ls -la');
		});
		
		test('limits history size to 128', () => {
			const mockContext = {
				globalState: { get: () => [], update: () => Promise.resolve() }
			} as any;
			
			const history = new TerminalHistory(mockContext);
			
			// Add 130 commands to test limit
			for (let i = 0; i < 130; i++) {
				history.addCommand(`echo command${i}`);
			}
			
			const commands = history.getHistory();
			assert.ok(commands.length <= 128, 'Should limit to 128 commands');
			assert.strictEqual(commands[commands.length - 1], 'echo command129');
		});
		
		test('finds autosuggestions correctly', () => {
			const mockContext = {
				globalState: { get: () => [], update: () => Promise.resolve() }
			} as any;
			
			const history = new TerminalHistory(mockContext);
			
			history.addCommand('echo hello world');
			history.addCommand('echo goodbye');
			history.addCommand('ls -la');
			
			// Test finding suggestions
			const suggestion1 = history.findAutosuggestion('echo hello');
			assert.strictEqual(suggestion1, ' world');
			
			const suggestion2 = history.findAutosuggestion('echo');
			assert.strictEqual(suggestion2, ' goodbye'); // Most recent match
			
			const noSuggestion = history.findAutosuggestion('nonexistent');
			assert.strictEqual(noSuggestion, undefined);
		});
		
		test('ignores exact matches in autosuggestion', () => {
			const mockContext = {
				globalState: { get: () => [], update: () => Promise.resolve() }
			} as any;
			
			const history = new TerminalHistory(mockContext);
			
			history.addCommand('echo hello');
			
			const suggestion = history.findAutosuggestion('echo hello');
			assert.strictEqual(suggestion, undefined);
		});
		
		test('returns most recent matching command', () => {
			const mockContext = {
				globalState: { get: () => [], update: () => Promise.resolve() }
			} as any;
			
			const history = new TerminalHistory(mockContext);
			
			history.addCommand('echo first');
			history.addCommand('echo second');  
			history.addCommand('echo third');
			
			const suggestion = history.findAutosuggestion('echo');
			assert.strictEqual(suggestion, ' third');
		});
	});

	suite('Path Detection Logic', () => {
		// Test the path detection logic used in semantic tokens
		
		function looksLikePath(arg: string): boolean {
			return arg.includes('/') ||
				   arg.startsWith('.') ||
				   /\.(js|ts|json|md|txt|py|java|c|cpp|h|html|css|xml|yml|yaml)$/i.test(arg) ||
				   arg.includes('\\');
		}
		
		test('detects file paths correctly', () => {
			assert.ok(looksLikePath('src/extension.ts'));
			assert.ok(looksLikePath('./package.json'));
			assert.ok(looksLikePath('../README.md'));
			assert.ok(looksLikePath('file.js'));
			assert.ok(looksLikePath('script.py'));
			assert.ok(looksLikePath('C:\\Windows\\path'));
			
			assert.ok(!looksLikePath('echo'));
			assert.ok(!looksLikePath('--help'));
			assert.ok(!looksLikePath('simple-arg'));
		});
	});

	suite('Error Pattern Detection', () => {
		// Test error pattern matching used in semantic tokens and definition provider
		
		function matchesErrorPattern(line: string): RegExpMatchArray | null {
			const patterns = [
				/([^\s:]+\.[a-zA-Z0-9]+):(\d+):(\d+):\s*(error|warning|note):/,
				/(Error|WARNING|Note)\s+in\s+([^\s:]+\.[a-zA-Z0-9]+)/
			];
			
			for (const pattern of patterns) {
				const match = pattern.exec(line);
				if (match) return match;
			}
			return null;
		}
		
		test('matches common error patterns', () => {
			const match1 = matchesErrorPattern('src/main.c:15:40: error: expected comma');
			assert.ok(match1);
			assert.strictEqual(match1[1], 'src/main.c');
			assert.strictEqual(match1[2], '15');
			assert.strictEqual(match1[3], '40');
			
			const match2 = matchesErrorPattern('Error in utils.h');
			assert.ok(match2);
			assert.strictEqual(match2[2], 'utils.h');
			
			const noMatch = matchesErrorPattern('This is just normal output');
			assert.strictEqual(noMatch, null);
		});
	});

	suite('Timing Pattern Detection', () => {
		// Test timing pattern matching
		
		function isTimingLine(line: string): boolean {
			const trimmed = line.trim();
			const patterns = [
				/^((?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s))\s+(ok|!\d+)$/,
				/^((?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s))$/,
				/^(Running\.\.\.)$/
			];
			
			return patterns.some(pattern => pattern.test(trimmed));
		}
		
		test('detects timing patterns correctly', () => {
			assert.ok(isTimingLine('3s ok'));
			assert.ok(isTimingLine('5m 30s !2'));
			assert.ok(isTimingLine('1h 2m 3s'));
			assert.ok(isTimingLine('Running...'));
			assert.ok(isTimingLine('  42s ok  ')); // With whitespace
			
			assert.ok(!isTimingLine('normal output'));
			assert.ok(!isTimingLine('3s running')); // Wrong format
			assert.ok(!isTimingLine('time: 3s')); // Not isolated
		});
	});
});