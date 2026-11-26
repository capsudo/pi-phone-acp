# pi-phone-acp

[![npm version](https://img.shields.io/npm/v/pi-phone-acp)](https://www.npmjs.com/package/pi-phone-acp)
[![npm downloads](https://img.shields.io/npm/dm/pi-phone-acp)](https://www.npmjs.com/package/pi-phone-acp)
[![Line coverage](https://img.shields.io/badge/coverage-98.22%25-brightgreen)](#development-checks)
[![Node.js requirement](https://img.shields.io/node/v/pi-phone-acp)](https://nodejs.org/)
[![License](https://img.shields.io/npm/l/pi-phone-acp)](LICENSE)
[![Nix flake](https://img.shields.io/badge/Nix-flake-5277C3?logo=nixos&logoColor=white)](#nix-linux)
[![ACP v1](https://img.shields.io/badge/ACP-v1-blue)](https://agentclientprotocol.com/)
[![Platforms: Linux and macOS](https://img.shields.io/badge/platforms-Linux%20%7C%20macOS-lightgrey)](#install-and-configure)

ACP adapter making [pi-phone](https://github.com/picassio/pi-phone) available to [ADE](# "Agentic Development Environment")s such as T3 Code, bb, Orca, Zed...

This allows to **control a pi agent on an android phone** directly from computer **in the ADE**, like any other agent.

## How it works

### Architecture

```mermaid
flowchart LR
    subgraph Computer
        ADE["ADE"]
        Adapter["pi-phone-acp"]
        ADE <-->|ACP| Adapter
    end
    subgraph Phone["Android phone"]
        PiPhone["pi-phone<br/>Conversations · Agent · Tools"]
    end
    Adapter <-->|Web API over Tailscale| PiPhone
```

pi-phone manages the conversations, the agent and its tools. pi-phone-acp is just a way to display those conversations and interact with the agent remotely from an ADE.

Therefore disconnecting the ADE does not stop the agent.

### Remote access

It reuses the API of the remote browser interface (web UI) that comes with pi-phone. **No `adb`**, **wireless debugging**, phone SSH server, etc...

Both the computer running the ADE and the android phone must be on the **same Tailscale network**.

## Features

- **Action Approvals<sup>[1]</sup> :** Allow or deny phone action requests directly from the ADE.
- **Extension questions:** Answer questions and text-entry forms from pi-phone extensions.
- **Interviews:** Complete text and choice questionnaires, with multiple selections, notes, optional questions and final confirmation.
- **Rich context:** View code snippets, formatted Markdown, tables and option descriptions alongside questions.
- **Markdown source:** Display literal when requested (such as `**bold**` instead of rendered formatting).
- **Secrets input<sup>[2]</sup>:** Enter passwords and security codes in **masked prompts** for the following requests:
    - [x] Secret storage — prompts to save a secret in pi-phone Settings → Secrets.
    - [x] Browser sign-in — prompts to fill username/password fields in pi-phone's browser.
    - [x] Browser security code — prompts to fill a security-code field in pi-phone's browser.
    - [x] Desktop app sign-in — prompts to fill sign-in fields in a desktop app via remote computer control. [live test failed]
    - [ ] Chrome Remote Desktop setup — prompts for Google’s connection command and remote-access PIN.
    - [x] Extension Forms secret fields — prompts from extensions for fields with `secret: true`.
    - [x] Credential prompts within interviews.
    > Unchecked items are not yet forwarded, even as regular prompts. These requests must be answered on the phone.
- **Ordinary input fallback:** ADEs with form support but no private-input helper offer 2 fallback options: "Continue with ordinary input" or "Complete in pi-phone".
- **Rich-content fallback:** Forms containing images, interactive previews or other unsupported content stay on the phone, with a notice in the ADE rather than an incomplete form.

_[1] Requires permission mode to be set to "Supervised" in ADE, othwerise "Full access" can auto approve them.<br/>In any case pi-phone still decides which actions require approval._<br/>
_[2] T3 Code only._

Targets the pi-phone **build-508** interface (`c59e0ceb993dc0ded331eeb6758f86bbaed75cec`), ACP v1.<br/>
Tested on **T3 Code 0.1.8** (and Zed 1.28.1 for ordinary input fallback).

## Install and configure

### npm

Node.js 22 or later on Linux or macOS is required.

```sh
npm install --global pi-phone-acp
```

### Nix (Linux)

The flake packages the published `pi-phone-acp@1.3.0` npm archive, not the repository's TypeScript. It supplies Node.js 24 and a locked set of npm runtime dependencies. Supported flake systems are `x86_64-linux` and `aarch64-linux`. Both methods below require Nix with flakes enabled.

#### Command line

Run without installing, using the configuration described below:

```sh
nix run github:capsudo/pi-phone-acp -- --doctor
```

Or install into a user profile:

```sh
nix profile install github:capsudo/pi-phone-acp
```

#### Flake input (NixOS / Home Manager)

Add an input to the configuration's `flake.nix`:

```nix
inputs.pi-phone-acp = {
  url = "github:capsudo/pi-phone-acp";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

In a NixOS module with `inputs` and `pkgs` in scope:

```nix
environment.systemPackages = [
  inputs.pi-phone-acp.packages.${pkgs.stdenv.hostPlatform.system}.default
];
```

For Home Manager, use the same package in `home.packages`. Pass `inputs` through NixOS `specialArgs` or Home Manager `extraSpecialArgs`, or capture the flake input in the module's surrounding scope.

The configuration's `flake.lock` records the adapter revision. The optional `follows` uses the configuration's nixpkgs; omit it to use this project's locked nixpkgs instead.

### Configuration

The same runtime settings apply to all installation methods. Installation does not start a service or provision phone access.

> Keep token values and token files outside Nix expressions and flake sources: they can become readable in the Nix store. Only pass the external private file's path at runtime.

| Environment variable | Value |
| --- | --- |
| `PI_PHONE_URL` | Explicit service origin, such as `http://PHONE:8787`. No sign-in token, path or query string. |
| `PI_PHONE_TOKEN_FILE` | Absolute path to an owned, private regular file outside the repository containing only the device-session token. Owner-only permissions such as `0600` are required. Symlinks are refused. |
| `PI_PHONE_CWD` | Existing local folder inside pi-phone, default `~/work`. This is not T3's project directory. |
| `PI_PHONE_SECRET_FILES_DIR` | Optional exact canonical T3 secret-delivery directory, default `~/.t3/userdata/secrets/files`. Set explicitly for custom T3 server layouts. Private forwarding currently requires Linux. |
| `PI_PHONE_SOCKET` | Optional private local socket path. Normally selected automatically. |

Use a separately provisioned pi-phone device-session token from the existing sign-in flow. The adapter sends it as a Bearer token with `X-Pocket: 1`. It does not perform sign-in, store cookies, alter networking or manage provider credentials. Keep the token out of command arguments, Git, notes and `codesync/`. Only send plain HTTP through an already authorized, encrypted Tailscale connection.

```sh
pi-phone-acp --doctor
pi-phone-acp
```

`--doctor` performs an authenticated read of `/api/me`. A successful response establishes reachability and a compatible response shape, **not** the installed APK hash or running runtime version. Normal execution reserves stdout for newline-delimited ACP JSON. Diagnostics go to stderr without raw request or response details.

> After installation, add `pi-phone-acp` to the ADE as an ACP agent.

## Behavior

- pi-phone reachability / ACP connection
    - on startup: pi-phone reachability is verified before each ACP connection with an authenticated `/api/me` call (10-second timeout). If pi-phone is unreachable or access is rejected, the connection is refused. In T3 Code, a warning banner is displayed when this happens during a provider check.
    - regular  checks: While idle, pi-phone-acp checks pi-phone reachability every 5 minutes. An earlier check may be made after an unsuccessful request to pi-phone.
    - ACP connection state and pi-phone-acp process:ACP connection is closed if pi-phone rejects access or returns an incompatible API response, or if it becomes unreachable. **pi-phone-acp stays running** to check for recovery.
- persistent relay adapter: ADEs start a new process for each ACP connection, leaving previous processes running. For pi-phone-acp, old process would still periodically check pi-phone reachability. Therefore, a relay mechanism is used so every pi-phone-acp process actually act a relay to the same persistent adapter, which stays running and check pi-phone reachability. 
- Reconnecting restores the pi-phone conversation and observes existing work without restarting it or sending another prompt.
- Secret-store prompts values are saved in pi-phone Settings > Secrets. This is not the case for browser sign-in prompts which only fill corresponding fields. 
- Interview answers are saved in pi-phone and returned to the LLM.

## Limits

- The phone's model, instructions and tool permissions apply, and the ADE's local sandbox does not restrict phone tools.
- Prompts support text only, and responses appear message by message rather than token by token.
- Messages sent to the same phone conversation from another client can make the ADE turn fail because the adapter cannot reliably identify which response belongs to it.
- After an adapter disconnection, questions still waiting on the phone must be completed there, whether they appeared in the ADE earlier or were asked while disconnected.
- Forms with partially completed answers saved on the phone (entered text or selected choices), or with saved sign-in choices, must be completed through the phone's interface.
- When falling back to ordinary input (when ADE does not support Masked Inputs), "secrets" may be visible and retained in the ADE history or logs.

### T3 Code specific

- T3 stores ordinary form answers in history and trims outer whitespace from both ordinary and private input.
- Interrupted secret-file delivery can leave a temporary file for T3's existing cleanup.
- T3 Masked input is used (among other requests) for A. requests to fill secret fields in Extension Forms and B. credential prompts within interviews but this can give a misleading impression of protection since for A. nothing guarantes that the extension handle those safely and B. the interview "answer" (all the values user has chosen) is sent back to the LLM in plain sight.


## Development checks

Build from source and run the checks:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:coverage
npm audit --omit=dev
```

`npm run test:coverage` runs the same tests with coverage for `src/`, including CLI subprocesses and unexecuted files. Type declarations, including the type-only `src/phone.ts`, are excluded. It prints a summary and writes an HTML report to `coverage/index.html`, LCOV to `coverage/lcov.info`, and a JSON summary to `coverage/coverage-summary.json`. Reports are ignored by Git. No minimum coverage threshold is enforced. The badge shows a manually updated local line-coverage snapshot, not an automated CI result.
