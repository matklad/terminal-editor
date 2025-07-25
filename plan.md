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
- [X] Let's change the logic to use the _left_ rather than the _right_ pane for the editor.
- [X] Syntax highlighting works semantically, but it requires special support from the color theme
      to actually set the colors. Let's use some standard tokens and scopes, even if they are not a
      prefect semantic match.
- [X] While the command is running, display running time. Update the time every second.
      Format is `1h 2m 3s`.
      When command finishes, prepend exit code: `0 3s` or `2 3s`.
      The time/exit code is last line.
      Don't forget to add syntax highlighting.
- [X] If that can be done in not too hacky way, add fish-shell style autosuggestions from history.
      History doesn't need to persist across restarts, can be in memory.
- [X] Provide highlighting and goto definition for all path in the output, and only only for the
      paths in error messages.
- [X] Change `reveal` command such that, if the terminal is already visible, the command is simply re-run
- [X] Make sure that timing and exit code information is the last like. When command finishes, it
      now ends up before the output.
- [X] Remove blinking highlights for seconds, to make it less annoying.
- [X] Inline suggestions show up correctly, but aren't actually accepted on arrow right/end, we
      need to fix it.
- [X] When highlighting and go-to-defintion on paths, handle `/path/file.ext:line:column` syntax even outside of error message
- [X] In the status output, use `3s ok` instead `0 3s` and `3s !2` instead of `2 3s`.
- [X] Use `String` as token type for paths for highlinghting.
- [X] allow '-' in absolute paths.
- [X] there's a bug where timing information is repeated at the start end at the end:

      ```
      8s
      info(fuzz): Fuzz seed = 16721927544116063590
      ... more output ...
      zig --seed 0x75c3a63b -Z4a634d9a4462c38e fuzz -- lsm_manifest_log

      1 9s
      ```

      Fix it by maintaining stout, stderr and timeing informatin logically, and materializing full
      file text as needed. Also avoid producing more than 128KiB output (the logical stdout can be large, just don't display it all)
- [X] Make the history used for autosuggestions persistent across restarts. Store at most 128 items
      of history.
- [X] For auto suggestiong logic, make right arrow accept one word and end accept the whole suggestion. 
