# Privacy policy

monitor-rearm runs entirely inside Claude Code on your machine. It has no server and
collects no telemetry. Nothing is sent to the author or to any third party.

## What it reads

The input of each `Monitor` call the main conversation makes, its task id, and the
background-task notifications Claude Code delivers, through the plugin API.

## What it writes

Nothing to disk. It keeps the input of each running long watch in memory for the
session, starts the watch again with that input when it expires, and rewrites the
transcript line Claude Code adds for the notice it drops. It reads the permission
check of its own re-arm call to approve it.

## Contact

Questions go to [GitHub issues](https://github.com/nnemirovsky/cc-monitor-rearm/issues).
