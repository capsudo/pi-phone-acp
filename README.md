# pi-phone-acp

ACP adapter connecting T3 to an existing pi-phone service over Tailscale. The phone owns conversations, tools and running tasks. Closing T3 or stopping the adapter only disconnects observation. No adb, wireless debugging, phone SSH server or phone fork is required.

The implementation targets the published **build-508** interface at `c59e0ceb993dc0ded331eeb6758f86bbaed75cec`. Automated tests use source-shaped fixtures and real ACP stdio processes, not the Android APK. Live T3 validation covers native risky-action Deny and basic interview text, choice and withheld-submission flows. Native asks and code/rich context have automated coverage only; the installed phone runtime version remains unverified.

## Build and configure

Node.js 22 or later on Linux or macOS is required. Build on the machine that will run the adapter, normally the T3 server.

```sh
npm ci --ignore-scripts
npm run build
```

| Environment variable | Value |
| --- | --- |
| `PI_PHONE_URL` | Explicit service origin, such as `http://PHONE:8787`. No sign-in token, path or query string. |
| `PI_PHONE_TOKEN_FILE` | Absolute path to an owned, private regular file outside the repository containing only the device-session token. Owner-only permissions such as `0600` are required. Symlinks are refused. |
| `PI_PHONE_CWD` | Existing local folder inside pi-phone, default `~/work`. This is not T3's project directory. |

Use a separately provisioned pi-phone device-session token from the existing sign-in flow. The adapter sends it as a Bearer token with `X-Pocket: 1`. It does not perform sign-in, store cookies, alter networking or manage provider credentials. Keep the token out of command arguments, Git, notes and `codesync/`. Only send plain HTTP through an already authorized, encrypted Tailscale connection.

```sh
node dist/cli.js --doctor
node dist/cli.js
```

`--doctor` performs an authenticated read of `/api/me`. A successful response establishes reachability and a compatible response shape, **not** the installed APK hash or running runtime version. Normal execution reserves stdout for newline-delimited ACP JSON. Diagnostics go to stderr without raw request or response details.

After separately approving provider setup, T3 can use a **Local ACP command** with the absolute Node executable and the absolute `dist/cli.js` path as its argument. Set the environment variables on that same T3 server. Building the adapter does not install or register a provider.

## Behavior and limits

T3 negotiates ACP v1. New ACP sessions create native phone conversations. T3 can reload those same native IDs after reconnecting. Reloading replays saved history and resumes observation of existing work without sending a replacement prompt. There is no local conversation database, automatic task restart, native-session listing or model switching. The phone's configured model and instructions apply.

The adapter uses authenticated long polling with acknowledged sequence numbers. If a poll session expires, it reads a fresh snapshot and fills history gaps without replaying committed output twice. Text and thoughts appear at committed message boundaries, not token by token. Tool progress and output update while work runs. Incoming ACP prompts currently support text only.

A lost submission response is an unknown outcome, not permission to retry. The adapter never retries session creation or submission automatically. After an uncertain turn it refuses another submission until the conversation is explicitly reloaded. Inspect the phone history before retrying. Do not write to the same conversation from another client during an ACP prompt. Build 508 does not expose a submission-to-transcript mapping, so detected concurrent human writers cause an error rather than a guessed success.

Only an explicit ACP cancellation invokes pi-phone's Stop action. **Stop is conversation-wide and also withdraws queued messages.** Transport loss, stdin EOF, process signals and approval-dialog cancellation do not invoke Stop. The phone and Android still control background survival. The adapter cannot make an Android-killed task resume exactly once.

Simple phone approvals, including native risky-action cards, become T3 allow-once/deny-once questions with the action and location shown. T3's permission mode may answer those questions automatically. Supported non-sensitive ask forms and text/choice interviews use structured ACP elicitation during an active T3 turn, never permission buttons. Interviews support code and portable Markdown context, Other, choice notes, explicit Skip and final Submit; defaults are described, not selected automatically. T3 trims outer whitespace and stores ordinary answers in history.

Passwords, one-time codes, mixed sensitive forms, media/image/interactive-HTML interviews and existing phone drafts remain phone-only with a notice. Reconnect replay does not open forms outside an active T3 turn. A protocol Cancel leaves a question waiting; Decline refuses an ask or skips an interview. T3 0.1.8 does not expose a form-only Cancel control: final `false` leaves an interview on the phone, while global Stop can stop phone work. Disconnect never invents an answer. See [interactive prompt mapping](docs/interactive-prompts.md) for supported content and privacy findings.

The adapter does not impose a T3 sandbox on phone tools. The reported phone grants pi-phone app-wide KernelSU root access, so authenticated remote execution must be treated accordingly.

T3's file, terminal, Git and checkpoint panels remain on the T3 host. Client MCP servers are not executed or forwarded to Android, and the adapter reports this explicitly when T3 supplies them. Configure tools on the phone instead. Additional client workspace roots and client system prompts are refused rather than silently treated as phone configuration.

## Development checks

```sh
npm run check
npm test
npm audit --omit=dev
```

Tests cover submission uncertainty, cancellation, disconnects, process replacement, poll replay/expiry, compaction history, native approvals, structured form answers, unsupported/private input safeguards, credential files and stdout isolation. Automated checks do not establish live interactive rendering or the installed phone runtime version.
