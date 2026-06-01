# Verification Sandbox Design

## Problem

`packages/pipeline/src/verification-runner.ts` executes tests and frontend smoke checks derived from untrusted repository content. A command allowlist prevents direct shell metacharacter injection, but the code being tested still runs arbitrary Python, Node, and browser-like JavaScript. Running that code with the pipeline service environment could expose secrets such as LLM API keys, GitHub credentials, Redis URLs, and local private key files.

## Decision

Use a disposable Docker container as the outer verification boundary whenever Docker is available. The verification runner still builds argv from the existing allowlist, metacharacter gate, and shell-free tokenizer, then runs the allowlisted command or Node/jsdom frontend smoke inside `Dockerfile.verify`'s dedicated image.

Each run uses:

- `--network=none`;
- a read-only container filesystem with only the copied temp repo mounted read/write at `/workspace`;
- `/tmp` as tmpfs;
- `--cap-drop=ALL` and `--security-opt no-new-privileges`;
- a non-root UID/GID matching the service process;
- memory, CPU, and process-count cgroup limits;
- an environment limited to verification basics: `PATH`, `PYTHONPATH`, and `HOME=/tmp`;
- host-side wall-clock timeout, process-group kill, and `docker rm -f` cleanup.

The verification image contains Node, Python, pip, and image-local `jsdom`. The base image tag and `jsdom@29.1.1` are pinned; Python and pip are installed from that pinned Debian base image rather than exact apt build-revisions so fresh builds remain reproducible across Debian point releases. The image contains no application source, no repo cache, and no secrets. The runner builds `mosaic-verify:local` from `Dockerfile.verify` on demand when the image is absent; developers can also run `pnpm verify:image`.

## Fail-Closed Policy

`VERIFICATION_REQUIRE_SANDBOX` is a service-level config value parsed from a real boolean string (`1/true/yes/on` or `0/false/no/off`). If unset, it defaults from `NODE_ENV` after env parsing:

- `NODE_ENV=production`: Docker sandbox required, fail closed when unavailable;
- non-production or unset `NODE_ENV`: Docker sandbox preferred, fallback allowed.

When Docker is unavailable and sandboxing is required, verification returns `valid:false` with an isolation-unavailable error and does not run untrusted code.

## Fallback

The child-process fallback remains for local development. It keeps the original defenses: temp repo copy, scrubbed environment, shell-free execution, command allowlist, output caps, wall-clock timeout, process-group kill, and macOS `sandbox-exec` network denial. The old `ulimit -v` memory cap was removed because it could abort V8 at startup; fallback Node smoke relies on `--max-old-space-size`, while Docker runs use cgroup memory limits.

This fallback is weaker than Docker. On non-macOS hosts it cannot guarantee network denial, and it is not a filesystem jail. Production should leave `VERIFICATION_REQUIRE_SANDBOX` unset or true so Docker unavailability fails closed.
