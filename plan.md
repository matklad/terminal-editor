# Plan

terminal-editor is a VS Code extension that implements simple terminal in the text buffer. That is,
instead of using built-in terminal GUI, a user opens a (virtual) file, types commend into the text
file, presses enter, and sees the output in the same text file.

The extension will use minimal amount of dependencies possible, ideally, zero besides VS Code basic
API.

Here's a plan. After each step is finished, a commit is made to check it with [X] in this file.

- [X] Create an empty VS Code extension.
- [X] Add "terminal-editor.reveal" command that does nothing.
- [X] Add a smoke test that a the command works.
      From this point on, all commits MUST pass the tests.
- [X] Make the "terminal-editor.reveal" command reveal "terminal", which is just a virtual text
      file.
      Terminal should be revealed in the right side of vertical split.
      If the window is not split, it should be split.
      If it is split already, right side is re-used for the split.
      The "terminal" buffer should be a singleton.
      For now, set the contents of the buffer to "hello world".
      Add tests for the above behaviors.
- [X] Add "terminal-editor.execute" command that "runs" the command specified in the first line
      of the editor buffer.
      For now, simply split command on the whitespace.
      The result process stderr and stdout should be appended after the command. Stdout goes first, then stderr.
      The output is streamed.
      Write tests.
- [X] Change the logic of `execute` command to treat anything until the first blank like as a command,
      to make it easy to enter multiline commands.
      Write tests.
- [X] Remove dependency on glob in favor of explicitly listing all files with test
      Regenerate package-json.lock
- [X] Make the terminal editor editable, so that the user can actually change the command.
      Add a test.
- [X] When terminal editor is focused, bind cmd-Enter to `execute` command.
- [X] Make sure that command uses workspace root folder as its current working directory
- [X] Implement basic completion for paths in the command line.
      Add tests.
- [X] Implement syntax highlighting. Color the prompt differently. Color arguments that look like
      path. Use different colors for paths that exists and which do not exist.
      Add tests.
- [X] Let's get serious. The editor starts empty, no prompt, no output.
- [X] Clear the output before executing a new command.
- [X] If command output contains errors like `/file/path.zig:153:40: error: expected ',' after initializer`,
      highlight them.
      Add tests.
- [X] Make "goto definition" work for such paths.
- [X] If possible, highlight background for prompt line(s) differently, such that even in an empty
      terminal the first line is highlighted.
- [ ] Let's change the logic to use the _left_ rather than the _right_ pane for the editor.
- [ ] Syntax highlighting works semantically, but it requires special support from the color theme
      to actually set the colors. Let's use some standard tokens and scopes, even if they are not a
      prefect semantic match.
