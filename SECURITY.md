# Security policy

## Reporting a vulnerability

Report privately through GitHub, not in a public issue:

**[Open a private security advisory](https://github.com/nnemirovsky/cc-monitor-rearm/security/advisories/new)**

The report is visible only to the maintainer ([@nnemirovsky](https://github.com/nnemirovsky)) until an advisory is published, so nothing sensitive is exposed while a fix is prepared. Expect an acknowledgement within a week.

If the form is unavailable, open a normal issue that says only "I would like a private channel for a security report", with no details, and a private advisory will be opened for you.

Never attach real credentials, tokens, personal data or private files to a report. Describe the shape of the problem instead.

## Supported versions

Only the latest release gets security fixes.

## Scope

monitor-rearm approves its own `Monitor` calls, so the approval is the part that matters most. In scope:

- Approving any call other than its own re-arm: a call by Claude or another plugin, a command that differs from the one Claude's approved call started the watch with, or an approval outside a re-arm.
- A re-arm that gets past a deny rule.
- Re-arming a watch Claude stopped, a watch a subagent started, or a watch older than a day.
- Its per-session file under `/tmp/monitor-rearm/` being used to write somewhere else, for example through a symlink another local user planted.

Out of scope:

- A watched script that changes on disk between re-arms and runs without a fresh check. The README documents this.
- Anything that needs an attacker who can already run code as you or edit your Claude Code settings.

