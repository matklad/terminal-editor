# Plan

terminal-editor is a VS Code extension that implements simple terminal in the text buffer. That is,
instead of using built-in terminal GUI, a user opens a (virtual) file, types commands into the text
file, presses enter, and sees the output in the same text file.

The terminal output looks roughly like this:

```
./zig/zig build test
   -Dtest-filter="foo"

= time: 3s status: 1 =

src/test.zig:69:28: error: unused function parameter
```

That is, potentially multiline command entered by the user, a blank like, and the content generated
by the extension: status line enclosed in `=` and the actual output of the command.

The extension will use minimal amount of dependencies possible, ideally, zero besides VS Code basic
API.

The extension is just three files:

* `src/extension.ts` contains all the "glue" code for interfacing with VS Code APIs, it is the view.
* `src/model.ts` contains the business logic of the extension, which is mostly independent of the VS
  Code API.
* `src/extension.tests.ts` are the tests.

## Testing

The tests use snapshot testing to verify output format. Snapshots are stored in `src/__snapshots__/` and should be committed to git.

To update snapshots after fixing issues:
```bash
UPDATE_SNAPSHOTS=true npm run test
```

## Plan

Here's a plan for creating extension step-by step. After each step is finished, run `npm run test`
and `npm run lint` to make sure there are no problems, mark the step as done with `[X]` in this
file. Optionally add implementaiton notes for future readers if there are some non-trivial details
which are not obvious from the step destription itself.

This will regenerate all snapshot files with the current test output.

- [X] Remove the scaffolding command, and add three new commands with `terminal-editor.` prefix:
  `reveal`, `run`, and `dwim`.
  Implementation notes: each command is top-level function. They are after `activate`, because the
  code is read top-down.
- [X] Add `Terminal` class to `model.ts` which will hold _logical_ state of the terminal, but which
  won't directly display it. Terminal will have `status` and `output` methods to return status line
  and the output text respectively. They will return a `{ text: string }` object to allow for
  extensibility (we'll return highlights in the future). Use `= =` for status and `"hello world"`
  for output for now.
- [X] Show the output of the Terminal:
  - Add `terminal-editor` language
  - In extension.ts, add EphemeralFileSystem, whose job is only to prevent VS Code from showing save
    dialog. Important: the source of truth for all the state is the `Terminal` in the `model.ts`,
    and active in-memory editor's state. FileSystem is a no-op, just to make sure that the document
    isn't dirty from VS Code's POV
  - Implement terminal singleton. In extension.ts, create a global variable holding an instance of
    the terminal.
  - Implement "editor" singleton. Add code to the `reveal` command to show an existing terminal
    editor, if there's one, or create new if there isn't. At the start, assert that there's zero or
    one terminal editors.
  - Add `sync` function to `extension.ts` which synchronizes the state of the editor with the
    logical state of the terminal. Refer to the example at the begging of the document. Key point:
    the command is typed by the user, it exists only in the editor's state and is not mirrored in
    the `Terminal`, user is the source of truth for the command. The status and output are managed
    by the `Terminal`. To synchronize, find where the user input ends, and use editor commands to
    replace the rest. Note that the document can be completely empty at the beginning, in that case,
    use blank line as the user input, and add another blank to separate the status line, for two
    blanks in total at the beginning of the file.
  - Call `sync` every time the editor is created/revealed.
  - Add a test that checks that `reveal` command creates a terminal, and that second revel command
    doesn't create a duplicate. Also test cases where the terminal exists, and not visible, and
    where terminal is created, closed, and re-created.
- [X] Reveal quality of life:
  - Reveal into the second colum.
  - If Reveal create a new terminal, the cursor should be on the first line
  - Implement the `dwim` command, which reveals the terminal if its not already revealed, and
    focuses it if it is revealed ant not focused.
- [X] In the model.ts, add a `parseCommand` function that parses terminal command string into a list
  of program name and arguments. It should support simple quoting with double quotes to allow
  arguments with spaces. Besides the string, this function should also accept the cursor position,
  and return the index of the token the cursor is at, as well as within-token offset, for
  completion. If the cursor is on the whitespace between the tokens, the index/offset are undefined.
  Add unit-tests.
- [X] add run method to Terminal, which takes a command string and exetuces the command.
  - the string should be tokenized using parseCommand method
  - Terminal should store, as a state, currently executing process, the instant when execution was
    started, exit code, if execution has finished already, process captured standard outout and
    standard error, and the original comand line.
  - As an invariant, at most one process at a time can be executed. If `run` is called while the
    process is already running, the old process is first killed, and then a new is started.
- [X] change `Terminal.output` function to return process stdout and stderr. The total amount of
  lines returned should be limited. The limit shold be configurable by the user, and deafult to 50
  lines.
  Implementation notes: Added maxOutputLines property (default 50) and setMaxOutputLines() method
  for configurability. Output combines stdout and stderr, limiting to last N lines when exceeded.
- [X] implement settings for line limit, such that the user can adjust that.
  Implementation notes: Added "terminal-editor.maxOutputLines" configuration setting in package.json
  with default value of 50 (range 1-10000). Refactored to maintain model/view separation by creating
  TerminalSettings interface in model.ts and VSCodeTerminalSettings adapter in extension.ts. Terminal
  constructor now accepts settings parameter instead of directly accessing VS Code APIs. Added
  waitForCompletion() method to Terminal for testing and enhanced test to actually verify line limiting
  by executing a node process that generates 20 lines and confirming output is limited to 5 lines.
- [X] change `Terminal.status` function to return runtime and status informatino. Runtime should  be
  consice, human readable: `1m 3s`.
  Implementation notes: Added formatRuntime() method that formats duration as "Xs", "Xm Ys" format.
  Status shows "time: Xm Ys status: N" for completed processes and "time: Xm Ys" for active ones.
- [X] Implement `.run` user-visible command. It should execute currnt command line. It should also
  wire up callbacks/events such that sync function is called:
  - immediately after the command is run, to clear old result
  - after new output
  - every second, while the command is runnig, to update runtime.
  Implementation notes: Added TerminalEvents interface with onOutput and onStateChange callbacks.
  Terminal constructor now accepts events parameter. The run command extracts current command line,
  executes it via terminal.run(), immediately syncs to clear old result, then sets up 1-second
  interval to update runtime while process is running. Events trigger sync automatically on output
  and state changes. Added cleanup in deactivate() to clear intervals. Added comprehensive tests
  using helper functions (manyLinesCommand, sleepCommand, fastCommand, errorCommand) that use
  'node -e' to avoid dependencies. Tests cover command execution, error handling, runtime updates,
  event callbacks, and edge cases.
- [X] dwim should run current command, if the terminal is focused or visible
  Implementation notes: Modified dwim() function to check if terminal is focused and run command if so.
  Added comprehensive test suite covering all dwim scenarios: revealing terminal when not visible,
  focusing terminal when visible but not focused, and running command when terminal is focused.
  Exported visibleTerminal() function from extension.ts to enable proper test isolation.
- [X] add working directory to the Terminal. When creating terminal in extension.ts, initialize
  working direcory with the current workspace root directory.
  Implementation notes: Added workingDirectory property to Terminal class constructor and passed it
  to spawn() options as { cwd: this.workingDirectory }. Created getWorkspaceRoot() helper function
  that returns the first workspace folder's fsPath or falls back to process.cwd(). Updated both
  Terminal instantiations in extension.ts to use workspace root. Added unit test verifying Terminal
  respects working directory and integration test confirming workspace root is used correctly.
- [X] Make tests check `SLOW_TESTS` variable. From this point on, if a test takes longer than 500ms,
  it should be running only if `SLOW_TESTS` is set. Run tests to see which ones are slow. Apply this
  rule to them.
  Implementation notes: Added SLOW_TESTS environment variable check to the "Run command shows
  runtime updates" test (which takes ~3s). Test is skipped unless SLOW_TESTS=1 is set. Without
  SLOW_TESTS, test suite runs in ~700ms; with SLOW_TESTS, it takes ~4s but runs all tests.
- [ ] Move setInterval logic from extension.ts to terminal.ts. The terminal should be responsible for
  firing an event every second, _while_ the command runs. Add corresponding callback to TerminalEvents.
- [ ] Add full and folded mode to the terminal. In the full mode, all the output is displayed. In
  the folded mode, the number of lines is limited by maxOutputLines. Add `terminal-editor.toggleFold`
  command.
- [ ] Change the `status` command to add `...` before the closing `=` if the total size of the output
  is larger than maxOutputLines.
- [ ] If the cursor is on the status line, and the status line has `...` (the output is large), the
  tab key should run `toggleFold` command.
