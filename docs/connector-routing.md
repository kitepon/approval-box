# Connector routing after session replacement

Connector 0.1.13 uses these additive `/connector/v1` changes. Existing clients may omit route in amend. No app/Web API changes.

- `POST /decisions/:id/amend`: optional `route: {channel_id, harness}`. Updates route atomically with a successful version-checked amendment; rejected amendments leave route unchanged.
- `POST /decisions/:id/resume`: body `{channel_id, harness}`. Restricted to the original connection. Pending/held requests transfer their route and increment version, recording history. Answered requests return the answer and mark delivery fetched. Cancelled requests are rejected. Unrelated requests remain unchanged.
- The local MCP exposes `resume_decision({decision_id})`, resolves the calling parent, and includes `steer_channel` plus receive instructions when necessary. `amend_decision` resolves the calling parent too. Both are dispatch tools in hook registration.
- The daemon reconciles queued entries against server waiting deliveries. Removed requests have unclaimed messages withdrawn; changed routes only resend if withdrawing the old message succeeds. Emitted messages report delivered; claimed/ambiguous messages report unknown and are not resent.

Devices shared by several sessions must select requests explicitly. Listing all requests does not transfer ownership. Restarting a launcher does not automatically migrate routes.

## Claude Code process restart with the same session (connector 0.1.21)

A Claude channel is bound to the Claude process that opened it (pid plus start time). The shared delivery module stops waiting for a session when none of its channels has a live bound process, so that an answer is never emitted into another conversation.

Restarting the Claude app resumes the same conversation (same `session_id`) in a new process. Up to 0.1.20 the MCP reused the saved channel by `session_id` only. New requests after the restart were then routed to a channel bound to the dead process: the answer reached the device inbox (`queued`) but no hook emitted it, and the server stayed at `fetched` until the AI fetched it by itself (observed on Windows, 2026-10-10: K-52EM7S, K-D8CEZK, K-V3G6ZN).

From 0.1.21 the MCP reuses a saved Claude channel only when it is bound to the process that issued the current request (read from the `PreToolUse` record of that request). Otherwise it opens a new channel and remembers it. The old channel stays open: the waiter of the same session claims pending answers from all open channels of that session once one of them has a live process.

Up to 0.1.21 one case stayed uncovered: an answer that arrives after a restart while the conversation makes no new Approval Box request. No channel of that session was bound to a live process until the next request, so the waiter ended and the answer waited in the inbox.

## Answers that arrive after a restart without a new request (connector 0.1.22)

Connector 0.1.22 uses `aiterm-steer-delivery` 0.4.4. The waiter now stays alive as long as the Claude Code process that started the hook is alive, and emits pending answers from every open channel of the same `session_id` into that process, in arrival order. It still takes nothing from channels of other conversations, and it takes nothing when the process that started the hook is gone.

`setup` additionally registers a `SessionStart` hook (`asyncRewake`). A resumed conversation is woken by answers that arrived while it was stopped, before it runs a turn. Without re-running `setup` the existing registration keeps working: the resumed conversation receives such answers at the end of its first turn.

Still not delivered: after `/clear` the conversation has a new `session_id` (use `list_my_decisions` / `resume_decision`). When two processes hold the same conversation, only one waiter exists and the first one receives the answer.

Scope: Claude Code on macOS, Linux and Windows. Codex (Aiterm delivery), Cursor and Grok do not use this binding.

## Sending the same delivery to the same channel again (connector 0.1.22)

The daemon sends each delivery to a channel once and follows it through its journal. It sends the same delivery ID to the same channel a second time only when that record is missing: the journal was lost while the server still lists the delivery, or two daemons picked up the same delivery at the same time.

`aiterm-steer-delivery` 0.4.4 rejects such a send with `CHANNEL_DELIVERY_DUPLICATE` and adds no second message, also while the first one is still in the inbox (up to 0.4.3 the second message was accepted there and the conversation showed the answer twice). The connector does not report this rejection as a failed delivery. It reads the state of the message that is already in the channel and follows it: `emitted` is reported as delivered, an unclaimed message stays queued. A delivery ID that was withdrawn from that channel is still rejected and reported as failed.

## Telling the AI how an answer arrives and how to verify it (connector 0.1.23)

An answer that arrives while the AI is working is injected next to a tool result. In one real run (2026-10-11, Claude Code on Linux, K-GRELNG) the AI read the injected text, judged that it "arrived inside the tool result rather than from the user", and ignored it. The daemon had reported `delivered` (emitted): emitted does not mean the AI accepted the answer.

Two causes on the product side:

- Claude Code passes only `structuredContent` of a successful tool result to the AI. The guidance that `request_decision` wrote into the text part ("the answer arrives in this conversation") never reached it.
- The delivered text offered no way to check where it came from.

From 0.1.23:

- `request_decision`, `amend_decision`, `resume_decision` and `setup_test` put their guidance into `structuredContent.guide` as well as into the text. For a pending request it says that the answer arrives later in this conversation as text starting with `[Approval Box]`, that it may arrive together with another tool's result or a hook notification, and that `get_decision` confirms it.
- The daemon appends one line to every delivered answer: call `get_decision` with that `decision_id` to get the same answer. A tool the AI calls by itself is a source it does not have to doubt.

Scope: all four harnesses on macOS, Linux and Windows (the text is added in the shared MCP and daemon code). Whether an AI accepts an injected answer is still the AI's judgement; this change gives it the information and a way to verify.

## Process checks that slowed the machine down (connector 0.1.24)

Connector 0.1.24 bundles `aiterm-steer-delivery` 0.4.5. No connector code changed.

Up to 0.1.23 the Claude Code waiter (`approval-box-claude-hook.mjs`, started by a hook, waits up to one day per conversation) checked every 5 seconds whether its Claude Code process was still alive by reading the list of all processes of the machine. On Windows each read started PowerShell 7 and queried WMI. On 2026-10-12 a Windows PC with seven such waiters was visibly slow (reported by the owner of `aiterm-steer-delivery`). Every run of the receive hook, and the daemon's check of who claimed a delivery, read the full list as well.

From 0.1.24:

- The 5-second check asks the OS whether the pid exists and starts no process. The start time is compared at the first check and then once per 60 seconds, for that one process.
- Hook runs and the daemon read only the processes they need (the one process, or the hook's ancestors). On Windows this no longer uses WMI, except for a process that cannot be read without it.
- When Claude Code exits and the OS hands the same pid to another process right away, the waiter ends up to 60 seconds later (5 seconds before).

A waiter that is already running keeps the code it started with. It ends when it has emitted an answer, when its conversation ends, or after one day. Re-running `setup` replaces the daemon and points the hooks at the new runtime; waiters started after that use the new code.

Scope: the waiter and the hook-owner check are Claude Code on macOS, Linux and Windows. The daemon's claim check applies to channel deliveries (Claude Code, Cursor, Grok). Codex is delivered through Aiterm and does not run these hooks. The load was measured on Windows only.

## Node updated while a conversation stays open (connector 0.1.25)

Connector 0.1.25 bundles `aiterm-steer-delivery` 0.4.6 and changes how the MCP starts the delivery daemon.

A conversation keeps its MCP process for as long as it stays open, sometimes for days. Up to 0.1.24 that process started child processes with the Node path it was started from (`process.execPath`, the resolved real path). Homebrew installs Node under a versioned directory and removes the previous version on update, so after an update the path of an already running process no longer exists. On 2026-10-12 Node on the Mac went from 26.10.0_1 to 26.11.1 while conversations were open.

What failed, for an MCP process that was started before the update:

- Starting the delivery daemon (`ensureDaemon`, on each request and at MCP start). The daemon exits after 30 minutes without pending requests, so the MCP starts it again and again. Spawning a path that does not exist reports the error later, on the child process object, and with no listener Node ends the calling process. The MCP of that conversation died instead of only failing to start the daemon.
- Inside the shared module: the watcher that wakes a stopped Codex conversation, the Node used to run the Aiterm command, and the launch target of the waiters. These failed without a message.

From 0.1.25:

- The daemon is started with `liveNodeExecutable()` of the shared module: the Homebrew `opt` path when the running Node is a Homebrew versioned path, the running path when it still exists, otherwise `node` from `PATH`.
- A failed daemon start is written to `daemon.log` and to stderr with the name `DAEMON_LAUNCH_FAILED`, and the calling process keeps running.
- The three places inside the shared module use the same lookup (0.4.6).

Not covered: an MCP process that was started before 0.1.25 was installed keeps its old code. It is replaced when its conversation is opened again. Until then, an answer for that conversation is delivered once any newer process (a new conversation, or `setup`) has started the daemon.

The paths written to settings (`setup`) already used the Homebrew `opt` path (`setupNodeExecutable`) and are unchanged. On machines without Homebrew Node the values are the same as before.

Scope: the connector on macOS, Linux and Windows. The value changes only on machines where Node is installed by Homebrew. No server, app or Web API change.
