import * as vscode from 'vscode';
import { strict as assert } from 'assert';
import { testing, visibleTerminal } from './extension';

function command_print(text: string): string {
    return `node -e "console.log('${text}')"`;
}

suite("Terminal Editor Tests", () => {
    setup(async () => {
        // Ensure default settings before each test
        const config = vscode.workspace.getConfiguration("terminal-editor");
        await config.update("maxOutputLines", 40, vscode.ConfigurationTarget.Global);
        await testing.reset();
    });

    teardown(async () => {
        // Reset settings after each test
        const config = vscode.workspace.getConfiguration("terminal-editor");
        await config.update("maxOutputLines", 40, vscode.ConfigurationTarget.Global);
        await testing.reset();
    });

    test("hello world", async () => {
        // Open terminal editor
        await vscode.commands.executeCommand("terminal-editor.reveal");
        await testing.sync();

        // Get the editor and insert hello world command
        const editor = visibleTerminal();
        assert.ok(editor, "Terminal editor should be visible");

        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(0, 0), command_print('hello world'));
        });

        // Execute the command
        await vscode.commands.executeCommand("terminal-editor.run");
        await testing.sync();

        // Verify the result using snapshot with raw editor content (no JSON.stringify)
        testing.snapshot(`
node -e "console.log('hello world')"

= time: 0s status: 0 =

hello world

process: stopped
maxOutputLines: 40
history: node -e "console.log('hello world')"`);
    });

    test("dwim command behavior", async () => {
        // First test: dwim reveals terminal when none is visible
        assert.ok(!visibleTerminal(), "No terminal should be visible initially");
        
        await vscode.commands.executeCommand("terminal-editor.dwim");
        await testing.sync();
        
        const editor = visibleTerminal();
        assert.ok(editor, "Terminal should be revealed by dwim");
        
        // Add a command
        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(0, 0), command_print('dwim test'));
        });
        
        // Second test: dwim runs command when terminal is visible
        await vscode.commands.executeCommand("terminal-editor.dwim");
        await testing.sync();
        
        testing.snapshot(`
node -e "console.log('dwim test')"

= time: 0s status: 0 =

dwim test

process: stopped
maxOutputLines: 40
history: node -e "console.log('dwim test')"`);
    });

    test("fold and unfold functionality", async () => {
        // Set maxOutputLines to 2 to trigger folding with small output
        const config = vscode.workspace.getConfiguration("terminal-editor");
        await config.update("maxOutputLines", 2, vscode.ConfigurationTarget.Global);
        
        // Reset to pick up new setting
        await testing.reset();
        
        await vscode.commands.executeCommand("terminal-editor.reveal");
        await testing.sync();
        
        const editor = visibleTerminal();
        assert.ok(editor);
        
        // Create command with 5 lines of output
        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(0, 0), command_print('line1\\nline2\\nline3\\nline4\\nline5'));
        });
        
        await vscode.commands.executeCommand("terminal-editor.run");
        await testing.sync();
        
        // Should start folded - only show last line due to maxOutputLines=2 (accounting for newline)
        testing.snapshot(`
node -e "console.log('line1\\nline2\\nline3\\nline4\\nline5')"

= time: 0s status: 0 ... =

line5

process: stopped
maxOutputLines: 2
history: node -e "console.log('line1\\nline2\\nline3\\nline4\\nline5')"`);
        
        // Toggle to unfold - should show all 5 lines but status still shows ellipsis because output is large
        await vscode.commands.executeCommand("terminal-editor.toggleFold");
        await testing.sync();
        
        testing.snapshot(`
node -e "console.log('line1\\nline2\\nline3\\nline4\\nline5')"

= time: 0s status: 0 ... =

line1
line2
line3
line4
line5

process: stopped
maxOutputLines: 2
history: node -e "console.log('line1\\nline2\\nline3\\nline4\\nline5')"`);
        
        // Toggle back to fold - should show last line again
        await vscode.commands.executeCommand("terminal-editor.toggleFold");
        await testing.sync();
        
        testing.snapshot(`
node -e "console.log('line1\\nline2\\nline3\\nline4\\nline5')"

= time: 0s status: 0 ... =

line5

process: stopped
maxOutputLines: 2
history: node -e "console.log('line1\\nline2\\nline3\\nline4\\nline5')"`);
        
        // Reset maxOutputLines back to default
        await config.update("maxOutputLines", 40, vscode.ConfigurationTarget.Global);
    });

    test("command history and clearing", async () => {
        await vscode.commands.executeCommand("terminal-editor.reveal");
        await testing.sync();
        
        const editor = visibleTerminal();
        assert.ok(editor);
        
        // Run first command
        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(0, 0), command_print('first'));
        });
        await vscode.commands.executeCommand("terminal-editor.run");
        await testing.sync();
        
        // Clear command area and run second command
        await editor.edit(editBuilder => {
            const commandRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, editor.document.lineAt(0).text.length));
            editBuilder.replace(commandRange, command_print('second'));
        });
        await vscode.commands.executeCommand("terminal-editor.run");
        await testing.sync();
        
        // Should have both commands in history
        testing.snapshot(`
node -e "console.log('second')"

= time: 0s status: 0 =

second

process: stopped
maxOutputLines: 40
history: node -e "console.log('first')"
history: node -e "console.log('second')"`);
        
        // Clear history
        await vscode.commands.executeCommand("terminal-editor.clearHistory");
        await testing.sync();
        
        testing.snapshot(`
node -e "console.log('second')"

= time: 0s status: 0 =

second

process: stopped
maxOutputLines: 40
history: (empty)`);
    });

    test("process killing when starting new command", async () => {
        await vscode.commands.executeCommand("terminal-editor.reveal");
        await testing.sync();
        
        const editor = visibleTerminal();
        assert.ok(editor);
        
        // Start long-running command that will be killed (10 second timeout)
        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(0, 0), 'node -e "setTimeout(() => console.log(\'done\'), 10000)"');
        });
        await vscode.commands.executeCommand("terminal-editor.run");
        
        // Wait a tiny bit to ensure the process starts
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Don't wait for completion - start another command immediately
        await editor.edit(editBuilder => {
            const commandRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, editor.document.lineAt(0).text.length));
            editBuilder.replace(commandRange, command_print('quick'));
        });
        await vscode.commands.executeCommand("terminal-editor.run");
        await testing.sync();
        
        // The second command should complete, previous one should be killed
        testing.snapshot(`
node -e "console.log('quick')"

= time: 0s status: 0 =

quick

process: stopped
maxOutputLines: 40
history: node -e "setTimeout(() => console.log('done'), 10000)"
history: node -e "console.log('quick')"`);
    });

    test("output truncation with maxOutputLines setting", async () => {
        await vscode.commands.executeCommand("terminal-editor.reveal");
        await testing.sync();
        
        const editor = visibleTerminal();
        assert.ok(editor);
        
        // Create command that produces more output than maxOutputLines (40)
        const lines = Array.from({length: 50}, (_, i) => `line${i + 1}`).join('\\n');
        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(0, 0), command_print(lines));
        });
        
        await vscode.commands.executeCommand("terminal-editor.run");
        await testing.sync();
        
        // In folded mode, output should be truncated and status should show "..." 
        // The exact snapshot will depend on how the terminal handles truncation
        // This test verifies the truncation behavior exists
        const documentText = editor.document.getText();
        const outputLines = documentText.split('\n').filter(line => line.match(/^line\d+$/));
        
        // In folded mode with 40 line limit, should see truncated output
        assert.ok(outputLines.length <= 40, `Output should be truncated to 40 lines, got ${outputLines.length}`);
        
        // Status line should indicate truncation with "..."
        const statusLine = documentText.split('\n').find(line => line.startsWith('= time:'));
        assert.ok(statusLine?.includes('...'), "Status line should show '...' when output is truncated");
    });

    test("tab key behavior on status line with ellipsis", async () => {
        await vscode.commands.executeCommand("terminal-editor.reveal");
        await testing.sync();
        
        const editor = visibleTerminal();
        assert.ok(editor);
        
        // Create command with long output to trigger ellipsis
        const lines = Array.from({length: 50}, (_, i) => `line${i + 1}`).join('\\n');
        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(0, 0), command_print(lines));
        });
        
        await vscode.commands.executeCommand("terminal-editor.run");
        await testing.sync();
        
        // Should start folded with ellipsis
        const statusLine = editor.document.getText().split('\n').find(line => line.startsWith('= time:'));
        assert.ok(statusLine?.includes('...'), "Status line should show '...' when output is truncated");
        
        // Position cursor on status line
        const statusLineIndex = editor.document.getText().split('\n').findIndex(line => line.startsWith('= time:'));
        assert.ok(statusLineIndex >= 0, "Should find status line");
        
        editor.selection = new vscode.Selection(
            new vscode.Position(statusLineIndex, 5),
            new vscode.Position(statusLineIndex, 5)
        );
        
        // Execute tab command - should toggle fold since we're on status line with ellipsis
        await vscode.commands.executeCommand("terminal-editor.tab");
        await testing.sync();
        
        // Should now be unfolded
        const documentText = editor.document.getText();
        const outputLines = documentText.split('\n').filter(line => line.match(/^line\d+$/));
        assert.ok(outputLines.length > 40, `Should show all output when unfolded, got ${outputLines.length} lines`);
        
        // Tab again should fold back
        await vscode.commands.executeCommand("terminal-editor.tab");
        await testing.sync();
        
        const newDocumentText = editor.document.getText();
        const newOutputLines = newDocumentText.split('\n').filter(line => line.match(/^line\d+$/));
        assert.ok(newOutputLines.length <= 40, `Should truncate output when folded, got ${newOutputLines.length} lines`);
    });
});
