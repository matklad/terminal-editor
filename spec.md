# Terminal Editor Specification

A VS Code extension that implements a terminal within text buffers, allowing users to type commands
and see their output in the same file.

## Core Architecture

- [X] Extension consists of three main files:
  - `src/extension.ts` - VS Code integration and view layer
  - `src/model.ts` - Business logic and terminal state management

## File System Integration

- [X] Uses custom `terminal-editor` URI scheme for virtual files
- [X] Implements `EphemeralFileSystem` that prevents VS Code save dialogs
- [X] Files exist only in memory during session
- [X] Terminal documents use `.terminal` extension

## Commands

- [X] `terminal-editor.reveal` - Opens terminal in second column or focuses existing
- [X] `terminal-editor.run` - Executes current command line
- [X] `terminal-editor.dwim` ("do what I mean") - Reveals terminal or runs command if focused
- [X] `terminal-editor.toggleFold` - Toggles between full and folded output modes
- [X] `terminal-editor.tab` - Smart tab handling (fold toggle or default behavior)
- [X] `terminal-editor.clearHistory` - Clears command history

## Document Structure

- [X] Document format:
  ```
  command text (user input)

  = time: Xs status: N =

  command output
  ```

- [X] Command section: User-editable text at top
- [X] Status line: Shows runtime and exit code, starts with `=`
- [X] Output section: Process stdout/stderr combined
- [X] Blank lines separate each section

## Terminal State Management

- [X] Single global `Terminal` instance per extension activation
- [X] Terminal tracks current running process with metadata:
  - Process handle and spawn options
  - Start time and optional end time
  - Exit code when process completes
  - Captured stdout and stderr with ANSI processing
  - Original command line string

- [X] At most one process can run at a time
- [X] New process kills existing running process
- [X] Working directory defaults to workspace root

## Command Parsing

- [X] `parseCommand()` function tokenizes command strings
- [X] Supports double-quote escaping for arguments with spaces
- [X] Returns cursor position information for completion support
- [X] Handles cursor on whitespace vs. within tokens

## Output Management

- [X] Configurable output line limit via `terminal-editor.maxOutputLines` setting
- [X] Default limit: 50 lines (range: 1-10000)
- [X] Two display modes:
  - Folded: Shows last N lines only
  - Full: Shows all output regardless of limit

- [X] Status line shows `...` indicator when output exceeds line limit
- [X] `...` appears even in folded mode when output is large

## Folding Behavior

- [X] Terminal starts in folded mode by default
- [X] `toggleFold()` switches between modes
- [X] Tab key triggers fold toggle when:
  - Cursor is on status line
  - Status line contains `...` (indicating truncated output)
  - Otherwise executes default tab behavior

## Command History

- [X] Commands saved to history when executed
- [X] History persisted in VS Code global state
- [X] History loaded on extension activation
- [X] Maximum 128 commands in history
- [X] Duplicate consecutive commands not added
- [X] `clearHistory()` command empties history

## Runtime Display

- [X] Status line shows execution time:
  - Format: `Xs` for under 1 minute
  - Format: `Xm Ys` for longer durations
- [X] Updates every second while process runs
- [X] Shows final runtime when process completes

## Event System

- [X] `TerminalEvents` interface with callbacks:
  - `onOutput` - Fired when process produces output
  - `onStateChange` - Fired when process starts/stops
  - `onRuntimeUpdate` - Fired every second during execution

- [X] Events trigger document synchronization automatically
- [X] Sync only occurs when terminal is visible

## Synchronization

- [X] `sync()` function maintains document consistency
- [X] Preserves user command input
- [X] Updates status and output sections
- [X] Handles concurrent sync requests with queuing
- [X] Prevents race conditions with `syncRunning`/`syncPending` flags

## Syntax Highlighting

- [X] Status line highlighting with tags:
  - `punctuation` for `=` characters
  - `keyword` for `time:` and `status:`
  - `time` for duration values
  - `status_ok` for exit code 0
  - `status_err` for non-zero exit codes

- [X] Output highlighting detects:
  - File paths in format `path/file.ext:line:column`
  - Error messages containing `error:`
  - ANSI color codes and formatting

- [X] ANSI processing supports:
  - Colors: red, green, yellow, blue, magenta, cyan, white
  - Styles: bold, dim, underline
  - DEC Special Character Set for line drawing
  - Proper range tracking across multi-line output

## File Path Integration

- [X] Go-to-definition for file paths in output
- [X] Supports relative and absolute paths
- [X] Handles line:column navigation
- [X] File path regex matches common extensions

## Process Management

- [X] Spawns processes with `CLICOLOR_FORCE=1` for ANSI output
- [X] Uses workspace root as working directory
- [X] Handles spawn errors (command not found)
- [X] Captures both stdout and stderr
- [X] Process cleanup on extension deactivation
- [X] Runtime update intervals cleared on process completion

## Settings Integration

- [X] `terminal-editor.maxOutputLines` configuration setting
- [X] Settings abstracted through `TerminalSettings` interface
- [X] VS Code adapter pattern for settings access

## Editor Integration

- [X] Single terminal editor assertion (max one open)
- [X] Opens in second column by default
- [X] Cursor positioned at first line when created
- [X] Custom language mode for syntax highlighting
- [X] Keybinding for Tab key in terminal-editor files

## Testing

- [ ] All testing goes through snapshot mechanism for deterministic results
- [ ] Tests that spawn external processes use `node -e` to avoid environment dependencies
- [X] Extension exports testing object with three functions for test automation
- [X] `reset()` function fully resets extension and editor state
  - [X] Simulates deactivate/activate cycle
  - [X] Clears all terminal state and history
  - [X] Closes any open terminal editors
  - [X] Resets global Terminal instance
- [X] `sync()` function waits for all in-flight async work to complete
  - [X] Waits for running processes to finish
  - [X] Waits for pending sync operations
  - [X] Waits for runtime update intervals
- [X] `snapshot(want: string)` function captures and compares extension state
  - [X] Takes expected snapshot as string parameter
  - [X] Serializes complete extension state to human-readable string
  - [X] Compares actual state against expected `want` parameter
  - [X] Throws error with both actual and expected content on mismatch
  - [X] Uses inline snapshots only - no external files
  - [X] No automatic update logic - user manually updates snapshots
  - [X] Includes relevant state information:
    - [X] Current command text
    - [X] Process status (running/completed/none)
    - [X] Exit code and runtime if available
    - [X] Output content (respecting folded/full mode)
    - [X] Command history
    - [X] Fold state
    - [X] Settings values
