# Monitor Rearm

Claude Code stops every `Monitor` watch after at most 30 minutes and wakes Claude
with a notice telling it to re-arm the watch. Claude then spends a turn, rereading
the whole conversation, only to call `Monitor` again with the same input. Over an
afternoon of watching a pull request or a log that adds up to a lot of turns that
do nothing.

This plugin keeps the watch going itself. A minute before the watch would expire it
stops it and starts the same watch again, with the same input, so the expiry notice
is never sent. Claude is not woken, no tokens are spent, and nothing
shows in the transcript. Events from the new watch reach Claude as before.

If a watch expires anyway (see below), the plugin re-arms it then and drops the
notice, which leaves one dim line in the transcript:

```
⏺ ↻ re-armed PR checks (b5vptfscx)
```

Claude Code counts that as the session going idle again, so a minute later it sends
its "Claude is waiting for your input" notification, which a terminal may show as
an unread badge. The swap before expiry avoids both.

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
* The swap is driven by a timer that writes a small file,
  `/tmp/monitor-rearm/<session id>`, which the session watches; the file-change event
  runs the swap. Claude Code registers watched files when a session starts, so a
  session that was already running when you installed or updated the plugin falls
  back to re-arming on expiry until it is restarted. So does a watch whose swap was
  missed, for example while the machine slept.
* The re-armed watch has a new task id, which its events carry. `TaskStop` with
  either id, the first one Claude saw or the one in the latest event, stops it.
* A watch whose command exits on its own (the pull request merged, the build
  finished) is not started again, so its last output is not reported twice.
* Claude does not see the expiry notice, including its hint to widen a filter when a
  watch saw no events. A filter that never matches keeps running quietly until the
  day is up.
* The plugin approves its own re-arm, since Claude's call with the same command was
  approved when the watch started. See below.
* Your `PostToolUse` hooks in settings don't run for a re-arm or the `TaskStop` of
  a swapped watch. It is no work of Claude's, and a hook that shows the session as busy (a terminal status dot) would
  mark an idle session busy with no `Stop` to clear it.
* The plugin keeps its list of watches in memory. After a reload or an update of the
  plugin, watches started before it expire as usual.
* It reads the expiry notice by its text. If a Claude Code update changes that text,
  expiries go to Claude as before.

## Permissions

The re-arm is the plugin's call, not Claude's, whether it is a swap or a re-arm on
expiry. In auto mode the classifier judges
a call against the request Claude made it in, so for the plugin's call it has
nothing to judge and gives no verdict, and a prompt in the other modes would ask
you again about a command you already let run.

So the plugin approves its re-arm itself, and nothing else: only its own `Monitor`
call, only while it re-arms a watch, and only with the exact command Claude's
approved call started that watch with. Every other call, Claude's or another
plugin's, gets the usual check. The plugin turns only a pending ask into an
approval, so a deny rule still stops the re-arm.

A watch runs its command again on each re-arm, for up to a day. If the command is a
script that changes on disk in that time, the new version runs without a fresh
check.

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