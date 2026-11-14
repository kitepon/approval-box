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

## Answers to a conversation whose Claude Code process ended without SessionEnd (connector 0.1.31)

The daemon follows a `queued` Claude delivery until the hook of that conversation emits it or the channel is closed. Up to 0.1.30 "closed" meant only the `closed.json` mark that the `SessionEnd` hook writes. When the Claude Code process ends without running that hook (Aiterm starts the next conversation in a new process and ends the old one, a crash, a reboot), the mark is never written: the body stays in the inbox, the journal entry stays `queued`, and the server keeps `delivery=waiting` with no error. Observed on BellTeam on 2026-11-07 (K-CNYUNZ: answered 11:29:18 UTC, the applicant's process had ended before, nobody waited; the AI fetched it by hand at 11:46) and on 2026-10-24 (two deliveries still `queued` two weeks later). On the BellTeam device 65 of 612 channels ever received the mark.

From 0.1.31 the daemon decides from the receiver, every 2 seconds, for each `queued` Claude delivery:

- `closed`: the `closed.json` mark exists. Give up at once (as before).
- `present`: the process the channel is bound to (pid plus start time) is running, or a waiter of the same `session_id` (`claude-sessions/<session_id>/waiter.json`, the hook of a restarted Claude Code that resumed the conversation) is running. Keep waiting.
- `gone`: neither is running. Remember the first time this was seen (`orphaned_at` in the journal). After 5 minutes without a receiver, withdraw the unclaimed body from the inbox (so a late restart cannot receive it twice) and report `failed` with "the AI's conversation has ended". If the body was claimed meanwhile, follow it as emitted or unknown as before. When a receiver returns within the 5 minutes, the count restarts.

The server marks the delivery `unknown`, the app shows the answer as not received, and the AI gets the answer with `list_my_decisions` / `resume_decision` in its next conversation (the documented path for a conversation with a new `session_id`). Nothing is resent.

Not covered in 0.1.31: Cursor and background channels (Grok) have no bound process; they kept waiting as before. Background channels are covered from 0.1.32 (next section). The waiter record is read from the shared module's state layout; it will move to an exported function when the module offers one.

Scope: the daemon on macOS, Linux and Windows, Claude Code deliveries only. No server, app or Web API change.

## Answers on a background channel with no receiver running (connector 0.1.32)

Grok (and any client the MCP cannot bind to a conversation) gets its answers through a background channel: `request_decision` tells the AI to start the receive process (`approval-box-receive.mjs --channel <id>`) in the background, the process claims the next answer from the channel inbox, prints it and exits, and the AI has to start the `next_wait_process` for the next answer. Nothing else emits from a background channel. Up to 0.1.31 the daemon did not look at that process: an answer that arrived while no receiver was running stayed in the inbox, the journal entry stayed `queued`, and the server kept `delivery=waiting` with no error. Observed on BellTeam: K-7T8TZ2 and K-YF7BB8 (requested 2026-11-06 23:06 UTC from a Grok session, answered 00:45 and 00:46 UTC, no claim for 12 hours until the AI fetched them by hand with `resume_decision`), and K-7USNQ6 (2026-10-29: the receiver had just emitted another answer 39 seconds earlier and was not restarted; the body waited 9 days).

From 0.1.32:

- The receive entry writes `state/background-receivers/<channel_id>.json` (pid plus process start identity) before it starts waiting. The latest receiver of a channel overwrites the record.
- For a `queued` delivery on a channel of kind `background`, the daemon's receiver check is: the recorded receiver process is running → `present`; no record, unreadable record, or process gone → `gone`. The same 5-minute grace and the same withdraw-then-`failed` report as for Claude apply, with the detail "the background receive process is not running". `closed.json` still ends it at once.
- Cursor channels are unchanged (their hooks claim pending answers when the conversation runs).

The server marks the delivery `unknown`, the app shows the answer as not received, and the AI gets the answer with `list_my_decisions` / `resume_decision`. Nothing is resent. A receiver started within 5 minutes of the answer still claims it (the hard-link claim and the daemon's withdraw cannot both succeed).

Not covered: a Grok conversation hosted by Aiterm has no delivery path other than this receiver. Aiterm's parent delivery (`aiterm-parent-delivery`) accepts only Codex parents; a Grok parent would need that command and the shared module to grow a Grok target (owner of the shared module). Until then a Grok AI that lets its receiver end gets the answer only by fetching it.

Scope: the daemon and the receive entry on macOS, Linux and Windows. No server, app or Web API change.

## Replacing a settings file that another program holds open on Windows (connector 0.1.32)

`setup` writes each settings file by writing a temporary file next to it and renaming it over the target. On Windows the rename is refused with `EPERM` (or `EACCES`/`EBUSY`) while another program has the target open without delete sharing: Claude Code rewriting `.claude.json`, an antivirus scanning it. On the machine `fox` the Claude Code registration failed this way on every `setup` from 0.1.28 to 0.1.31 (`rename '.claude.json.<pid>.tmp' -> '.claude.json'`), while the Codex, Cursor and Grok files were written. The file's ACL and attributes were normal (checked by the host's owner on 2026-11-07).

From 0.1.32 `writeJsonFile` retries the rename on Windows for those three codes, 30 attempts with a growing pause (about 46 seconds in total), like graceful-fs does. Other errors and other platforms are not retried. When the retries run out, the original error is thrown with a note that another program holds the target. The temporary-file handling (keep for credentials and unknown journals, discard for regenerable settings) is unchanged.

Not covered: a program that keeps the file open for longer than the retries (then the message names the file and `setup` is run again after closing it).

## Waking a BellTeam seat whose conversation stopped before the answer (connector 0.1.34)

On BellTeam each Bot runs Claude Code in a seat. Aiterm can hibernate an idle seat: the native Claude Code process ends, and with it the hook waiter that would emit the answer. The seat resumes the same conversation (same `session_id`) when BellTeam delivers the next message to it. Up to 0.1.33 an answer that arrived during hibernation followed the 0.1.31 path: the channel was closed (SessionEnd) or had no receiver for 5 minutes, the daemon withdrew the body and reported `failed`, the server marked the delivery `unknown`, and nothing woke the seat. The AI got the answer only if it happened to call `resume_decision` later.

From 0.1.34:

- When `request_decision`, `amend_decision`, `resume_decision` or `setup_test` uses a channel and the MCP process runs in a BellTeam seat (`AITERM_SESSION_ID` is a seat name: a Bot ID, or `<bot-id>-1st|2nd-<suffix>`; fork seats excluded), the MCP writes `state/bellteam-requesters/<channel_id>.json` with that Bot ID. The daemon is shared by all conversations of the user and never uses its own environment to choose a Bot.
- When the daemon gives up a delivery because nobody can emit it (the channel was closed when sending, the closed mark appeared while queued, or no receiver for 5 minutes and the body was withdrawn), and the channel has such a record, it adds one entry to `state/bellteam-wakes.json` before reporting `failed`. A delivery is added once.
- For each entry the daemon first reads the decision. If the AI already fetched it (`delivery=fetched`) or it is no longer answered, the entry is dropped. Otherwise it calls BellTeam's public MCP (`POST http://127.0.0.1:4181/mcp`, header `X-Bellteam-Seat: <bot-id>`, tool `sendmessage`, target the same Bot ID) once. The message names the request by ID and subject, says the answer could not reach the stopped conversation, and asks to call `resume_decision` with that `decision_id`. It does not carry the answer: the AI gets it from Approval Box with `resume_decision` (the server returns the saved answer and marks it fetched).
- Accepted (`running`, `steered`, `delivered`), refused by BellTeam (an MCP error such as `BOT_NOT_FOUND`), or unknown (timeout, a reply that cannot be read, a daemon stop while sending): the entry is removed and not sent again. Only a failure before BellTeam received the request (connection refused, BellTeam restarting) keeps the entry and tries again later, at most every 10 minutes, until the decision is fetched.
- BellTeam wakes a hibernated seat when it delivers a message, in the same conversation. Waking and the conversation's lifecycle are BellTeam's and Aiterm's; Approval Box only sends the message.

Timing: when the seat ended with `SessionEnd`, the message is sent right after the answer; otherwise 5 minutes after the answer (the same grace as 0.1.31, which lets a restarted conversation receive the body directly). The app shows the answer as not received (`unknown`) until the AI fetches it, then `fetched`.

Not covered: conversations whose MCP process started before 0.1.34 was installed write no record and are not woken (they are replaced when the seat restarts its CLI). Outside BellTeam nothing changes. The local BellTeam MCP address is fixed (`shortcut: BellTeam's local MCP address 127.0.0.1:4181, read it from BellTeam if it ever becomes configurable`).

Scope: the connector MCP and daemon on Linux in BellTeam seats, all channel kinds that the daemon gives up (Claude Code and background). No server, app or Web API change.

## BellTeam acceptance label (0.1.35)

BellTeam public sendmessage returns `queued` for a durably accepted wake of a sleeping seat. `sendWake` classifies this as accepted and retains `queued` in its detail. This changes the daemon log label only; accepted/unknown still terminate the existing wake journal without duplicate send. The earlier a49 live wake/fetch acceptance remains valid and is not repeated.
