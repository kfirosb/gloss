# GLOSS mobile — interaction study

Standalone, disposable HTML mockup for task 38. Open `index.html` directly, or serve
this directory with a local HTTP server. No build, external fonts, or network
dependencies are required. No production application files are changed.

Use the left screen index to navigate; **All screens** displays the complete
screen inventory. At phone width, the preview fills the viewport. **Reset demo**
restores the starting state. Escape returns to Home.

## Included screens

1. Home: unread stories, response cards, and status filters.
2. Decision story: agent response and labeled quick choices.
3. Completion story: finished work with two design previews.
4. Approval story: exact command and explicit allow/deny controls.
5. Chat: conversation history and entry into the composer.
6. Composer: draft, sample attachment, and simulated dictation.
7. Review: editable instruction before explicit sending.
8. Image viewer: two horizontally scrollable previews and zoom.
9. Inbox: search and unread filter.
10. Profile: all four sample projects.
11. Project: sessions and worktrees.
12. Activity: agent and delivery events.
13. Settings: text size, dark appearance, Hebrew, and notifications.
14. Welcome.
15. Pairing instructions and a nonfunctional sample QR.
16. Computers/devices: access toggle and sample revocation.
17. Offline: last-known response and a draft that is never auto-sent.
18. Uncertain delivery: check receipt without resending.
19. No unread responses, while an already-seen decision still awaits a reply.

## Read behavior

Opening a response does not immediately mark it seen. In the interactive view,
the end of the message must be fully visible for 1.2 seconds. This is an
illustrative reading heuristic, not proof the user actually read the message.
The all-screens gallery never changes read state. Seen and answered are separate.

## Prototype boundaries

All data, delivery acknowledgements, pairing, permissions, voice transcription,
attachments, and encryption claims inside the app UI are illustrative. No camera,
microphone, filesystem upload, agent, or cloud service is accessed. The QR is
decorative and not scannable. State is held only in memory and resets on reload.
Project session lists are sample layouts, not a complete backing data model. No backend or hosting choice is made.

The UI deliberately proposes mobile approval handling for review; this does not
change GLOSS's native-agent consent boundaries or implement remote approvals.
