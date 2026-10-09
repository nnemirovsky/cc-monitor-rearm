# Monitor Rearm

Claude Code stops every `Monitor` watch after at most 30 minutes and wakes Claude
with a notice telling it to re-arm the watch. Claude then spends a turn, rereading
the whole conversation, only to call `Monitor` again with the same input. Over an
afternoon of watching a pull request or a log that adds up to a lot of turns that
do nothing.

This plugin re-arms the watch itself, the moment it expires, with the same input,
and drops the notice. Claude is not woken and no tokens are spent. In the transcript
each re-arm leaves one dim line:

```
⏺ ↻ re-armed PR checks (b5vptfscx)
```

Events from the re-armed watch reach Claude as before.

## What it re-arms

Only watches Claude asked for at the maximum, `timeout_ms` of 1800000 or more.
Claude Code's own instructions tell Claude to use the maximum for a long watch and
re-arm it on every expiry, which is what this does. Shorter watches expire as usual.

A watch re-armed for a whole day expires as usual too, so Claude gets to look at a
watch that has been running, maybe quietly, for that long.

Watches started by subagents are left alone.

## Things to know

* Re-arming runs the watch's command again. A command that prints the current state
  when it starts (`tail -f` without `-n 0`, a script that reports status on its first
  pass) repeats that every 30 minutes, as it would when Claude re-arms it.
* The re-armed watch has a new task id, which its events carry. `TaskStop` with the
  watch's first id, the one Claude saw, still stops it.
* Claude does not see the expiry notice, including its hint to widen a filter when a
  watch saw no events. A filter that never matches keeps running quietly until the
  day is up.
* The re-arm goes through the same permission check as Claude's own call.
* The plugin keeps its list of watches in memory. After a reload or an update of the
  plugin, watches started before it expire as usual.
* It reads the expiry notice by its text. If a Claude Code update changes that text,
  expiries go to Claude as before.

## Requirements

Claude Code 2.1.289 or later, with function-hook mods available to your account.

## Install

```
/plugin marketplace add nnemirovsky/cc-monitor-rearm
/plugin install monitor-rearm@monitor-rearm
```

There is nothing to configure.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
