---
name: language
description: Use when the user asks to discuss or prepare coding instructions in another language while staying attached to this Claude Code session.
---

Start the local Gloss app with the current project and `${CLAUDE_SESSION_ID}`. Pass the language the user named in `$ARGUMENTS` to the launcher as its language code (for example `fr` for `/language french`). When `$ARGUMENTS` names no language, leave the language out so the launcher uses its default. The assistant opens a separate language conversation and keeps Claude Code permissions in Claude Code.

Run the project-local launcher described in the repository README. A language discussion is not a coding instruction. The user must review the exact English draft and press the destination-specific Send button before any peer request is delivered.
