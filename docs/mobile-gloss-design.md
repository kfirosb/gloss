# GLOSS mobile: responses, decisions, and conversations

Status: draft for user review. The visual direction and interactive mockup are
approved; this specification and production implementation are not yet approved.

Reference: task 38 in `docs/task-list.md`; prototype in
`docs/mockups/mobile/index.html`, with its inventory in the adjacent README.

## Intent

Give developers an excellent iPhone and Android interface for following agents
running on their computers. Reading and deciding should be easier than typing.
The product should feel like a thoughtfully adapted social messaging app: stories
for new responses, direct conversations with agents, and a personal project hub.

The user explicitly requested:

- Both iPhone and Android; access away from home Wi-Fi.
- Stories for agent responses, especially conversations needing a reply or choice.
- Minimal typing: faithful, labeled options and an always-available custom reply.
- Comfortable small/large text, scrolling images, and easy full-screen inspection.
- Instagram-style chat and a profile providing access to every project.
- A finished response starts unread; seen appears only after reading. Reading
  must not send an acknowledgement or imply a decision has been made.
- A hosted relay reached by outbound connections from both computer and phone.
- Cloudflare and Firebase are available candidates and may both be evaluated.

Success means a user can find a response, understand its context, inspect its
output, choose or write a reply, and verify delivery without losing their place.
An attractive mockup alone is not evidence that the interaction is successful.

## Approaches and decisions

The conversation considered Tailscale/private networking, a hosted message relay
using polling or persistent connections, and a managed-tunnel architecture like
T3 Connect. The chosen product direction is a hosted relay; it avoids requiring
users to install a VPN or configure a network. Caprock's encrypted relay and QR
pairing are useful references, not a code dependency or security audit.

Proposed implementation defaults, still subject to review:

- A responsive installable web app (PWA) shared across iPhone and Android, using
  the repository's React/TypeScript conventions. Native apps are deferred.
- WebSocket connections for live exchange. Polling remains an alternative if the
  infrastructure experiment demonstrates a material benefit. Transport does not
  define delivery semantics.
- QR-based device pairing without requiring a new GLOSS account for personal use.
- End-to-end encryption with an established protocol/library, not bespoke crypto.
- A live relay with bounded transient buffers, not a cloud transcript archive or
  offline instruction queue in the initial release.
- Cloudflare is the first relay experiment; compare an equivalent implementation
  in the user's Firebase/Google Cloud environment before selecting production
  hosting. A Cloudflare Worker cannot simply be deployed unchanged to Firebase.
  Select supported hosting primitives from current official documentation during
  planning; no resources or spending have been authorized by this document.

## Product scope and screen inventory

Preserve the approved warm cream, terracotta and sage palette, readable type,
quiet surfaces, and clear hierarchy. Adapt layouts for large text and RTL rather
than shrinking content to fit. The prototype is a disposable reference, not
production code to transplant wholesale.

1. Home: stories, unread count, response cards, and All / Unread / Needs you /
   Running filters. Items show project, agent, session, freshness, and status.
2. Decision story: full latest response, relevant context, labeled quick choices.
3. Completion story: finished response and media; no forced reply or review action.
4. Approval story: exact request and scope; permitted actions depend on the
   approval policy below, not on the existence of buttons in the mockup.
5. Chat: chronological conversation, agent identity, earlier context, attachments,
   delivery indicators, and access to writing.
6. Composer: text, image attachments, optional dictation, and preserved drafts.
7. Review: translated instruction, editable before an explicit Send action.
8. Image viewer: horizontal collection, pinch/controlled zoom, pan, close/back,
   captions and image position. Avoid conflicting story-swipe and image gestures.
9. Inbox: session search, unread filter, and independent activity indicators.
10. Profile: all accessible projects and links to settings/devices.
11. Project: its actual sessions, worktrees, active and saved conversations.
12. Activity: new responses, requests and delivery outcomes; no noisy token stream.
13. Settings: type size, appearance, writing/reading language, notification privacy.
14. Welcome: explain that the computer runs the agents and must stay online.
15. Pairing: computer-displayed QR, device confirmation, access scopes and expiry.
16. Devices: online status, read-only/read-and-reply permissions, revoke and disable.
17. Offline: last-known content clearly labeled and drafts that are not auto-sent.
18. Uncertain delivery: preserved instruction, status reconciliation, no blind retry.
19. Caught up: no unread responses; pending decisions can still remain.

Normal bottom navigation is Home / Chats / Activity / You. Stories, media,
composer and review are focused views with a reliable return path. Do not add a
new navigation destination for every state in the screen inventory.

## Read and action state

Represent these independently:

- Response revision: stable session identity plus completed native message identity
  and revision. Existing core contracts remain authoritative.
- Read state: unseen or seen through a particular response revision.
- Attention: ordinary response, question, approval, or none.
- Activity: running, waiting, ended, disconnected, or unknown.
- Delivery state: draft, submitting, accepted by relay, received by computer,
  delivered through the existing agent send path, failed, or uncertain.

New completed responses become unread regardless of whether they ask a question.
Streaming tokens are not individual stories. Translation completion does not
create a second response or a new unread revision.

Proposed reading rule: require the rendered response end to remain visible for
1.2 seconds while the app is foregrounded and the response view is active. Large
responses require scrolling to the end. A feed preview, notification, thumbnail,
gallery view or background tab never marks the response seen. This is a UI
heuristic, not proof of comprehension; include Mark unread in the response menu.

Sync seen revisions monotonically to the computer, keyed by session and response
identity. A late receipt must not mark a newer response seen. Computer and phone
should converge on shared read state; use existing desktop seen policies rather
than replacing them. Offline read receipts may sync later, unlike agent commands.

Reading does not answer questions, dismiss approval requests, send messages, or
close sessions. Keep seen-but-unanswered decisions in Needs you. Ordinary completed
responses remain accessible in All, project history and chat after being read.

## Quick replies and composition

Prefer structured options from a provider when available. Bind every actionable
choice to its session, target identity, prompt identity/revision and option ID.
Immediately before execution, the computer rechecks the target and whether that
prompt is still current. Stale choices become unavailable with an explanation.

For unstructured text, derive choices only when they can be mapped unambiguously
to the original text. The first production slice may support only structured or
strictly parsed choices. Freeform model-generated suggestions are a later extension;
they must be labeled and cannot manufacture approval requests or authorizations.

Use descriptive labels, such as “Choose another payment method”, not unexplained
numbers. Explicit option selection may send immediately where existing send and
translation policies allow it. Otherwise show the required review first. Multi-
select prompts require a separate Send selection action. Always offer Write
something, and preserve the destination prominently during composition/review.

Reuse existing language, review, attachment and destination policies. Translation
runs on the computer. Drafts are isolated by computer/session; reconnecting,
navigating, or receiving a new response must not submit or overwrite them.

## Approval boundary

The prototype includes Allow once / Deny as a design illustration. It does not
authorize bypassing the application's existing native-agent consent boundaries.
Current core contracts block or route native approval/dialog handling to the
terminal. Do not turn an inferred “Yes” into terminal input to bypass that policy.

Initial production scope: show approval requests and explain that they must be
answered on the computer. Ordinary supported composer replies remain available
only when current destination policies permit them. Native option dialogs have
the same restriction until a supported structured response adapter exists.

Remote approval is a separate implementation gate: it requires provider-supported
prompt identity, exact operation/scope presentation, stale-request rejection,
one-time decision consumption and an explicit extension to shared policies. The
user must review that scope before the illustrative approval buttons are enabled.

## Architecture and ownership

- `src/core`: shared response, read, attention, action and delivery contracts.
- Existing `src/runtime` application/send services: target validation, session
  discovery, translation and execution. Local HTTP host/origin restrictions stay.
- A new computer-owned relay client: opt-in lifecycle, pairing credentials,
  encryption, authenticated request allowlist and status reconciliation.
- A mobile presentation layer: reuse shared contracts and suitable UI primitives;
  separate touch navigation and story presentation from desktop window behavior.
- A hosted relay: route encrypted frames between authenticated connections,
  enforce isolation, size/rate limits and expiry, report connectivity. It cannot
  decrypt content, authorize agent operations, or call arbitrary local endpoints.
- Notification delivery: separate from the foreground connection. Prefer generic
  content-free notices by default; opening fetches authorized session content.

Remote capabilities are narrowly enumerated: list authorized projects/sessions,
read their conversations and permitted media, update read receipts, request
translation, send through approved composer paths, and query delivery outcomes.
Do not expose arbitrary filesystem reads/writes, shell input, desktop settings,
session creation or administrative actions as an accidental consequence of
reusing the desktop HTTP API. Computer-only administration manages device grants.

## Pairing, privacy and delivery

Use short-lived, one-use pairing invitations, explicit computer confirmation,
per-device credentials, read-only/read-and-reply scopes, and immediate revocation
of active connections. QR secrets must not enter server logs or referrers. Disable
access by default; turning it off ends remote capabilities without stopping local
agents. Lost credentials require pairing again; no cloud key recovery initially.

Select and review an established authenticated encryption handshake during
planning, including replay protection, key storage, rotation and reconnects. The
relay may see connection metadata; do not promise anonymity. An encrypted browser
app still trusts the code served by its web host: document that limitation.

The computer owns a durable command/delivery ledger. A client-generated request
ID survives transport retries. Duplicate requests return the recorded state;
they never independently inject another agent instruction. Do not promise exactly-
once execution across a crash at the agent-send boundary. Persist enough intent
and outcome state to fail uncertain rather than send twice.

Server acceptance alone is not Delivered. Delivered means the existing send path
confirmed delivery, not that the model has read or acted on the instruction.
Requests carry a short expiry and prompt/session binding; reject expired, revoked
or stale work. Do not retain executable commands for later offline execution.

Cache only conversations/media the user has opened, in a bounded local cache,
with clear last-sync labels and a clear-cache control. Do not cache credentials in
service-worker response caches. Disable or purge sensitive local caches on device
unpairing where reachable; revocation cannot remotely erase an offline phone.

Push permission is requested after explaining its value, through a user gesture.
Native browser push handles background notification delivery; polling is not a
background notification strategy. On unsupported/not-installed configurations,
show appropriate setup guidance rather than claiming push is enabled. Device
tokens and notification preferences require authenticated registration/revocation.

## Delivery sequence and hosting experiment

1. Shared contracts and mobile UI using fixtures, replacing prototype shortcuts.
2. Same protocol tested through a Cloudflare relay and a Firebase/Google Cloud
   candidate: authenticated connection, pairing, encrypted round-trip, reconnect,
   sleep/wake, revocation, payload limits and foreground latency.
3. Select one host using measured behavior, deployment complexity, documented
   limits and estimated costs at stated traffic/concurrency levels. Retain a
   transport boundary, not two production hosting systems.
4. Real paired read-only phone slice: session list, completed responses, images,
   read receipts, projects, offline status and local cache.
5. Supported quick choices, freeform/translated replies, attachments and delivery
   reconciliation. Add dictation using an explicitly selected supported approach;
   the prototype's sample transcription is not an implementation.
6. Push notifications, accessibility hardening and real-device validation.
7. Consider structured native dialogs/remote approvals through their separate gate.

A prototype deployment is not a public production launch. Prepare concrete
resource names, region, limits and expected spend before any billable deployment.
No desktop replacement, release, installation or DMG work is part of this design.

## Verification and acceptance

- Real iPhone Safari/home-screen and Android Chrome/installable experiences, not
  desktop emulation alone. Reading, keyboard, image zoom and background/resume.
- 375px and larger widths; large type, RTL mixed with code, dark appearance,
  VoiceOver/TalkBack, focus order, adequate touch targets and reduced motion.
- Response end visibility, hidden tabs, late seen receipts, translation changes,
  desktop/mobile read convergence and seen-but-unanswered decisions.
- No unpaired/revoked/cross-device access; bounded malformed payload handling;
  existing loopback and filesystem/security regressions remain passing.
- Correct session and prompt after navigation or concurrent desktop action;
  duplicates, stale questions, reconnects, crashes and unknown delivery receipts.
- Offline messages remain drafts. Reconnect never silently sends old instructions.
- Notifications open the correct session and preserve preview privacy settings.
- Follow repository verification and release protocols as applicable; report
  untested hardware, platform constraints and unsupported provider actions plainly.

## Calls to review

The visual design is approved. These are proposed implementation choices rather
than user requirements: PWA first, account-free QR pairing, live relay without an
offline command queue, 1.2-second reading heuristic, local bounded caching, and
computer-only native approvals initially. Hosting remains an experiment outcome.
Detailed crypto/library choice, concrete infrastructure and dictation transport
must be settled with current documentation before the implementation plan is final.
