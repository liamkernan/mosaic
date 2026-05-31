# Verification Sandbox Design

## Problem

`packages/pipeline/src/verification-runner.ts` executes tests and frontend smoke checks derived from untrusted repository content. A command allowlist prevents direct shell metacharacter injection, but the code being tested still runs arbitrary Python, Node, and browser-like JavaScript. Running that code with the pipeline service environment exposes secrets such as LLM API keys, GitHub credentials, Redis URLs, and any other ambient process configuration.

## Options

### Locked-down child process

Run each verification command, including the JSDOM frontend smoke check, in a subprocess with:

- a fresh environment containing only `PATH` and `PYTHONPATH`;
- no inherited service secrets or cloud credentials;
- shell-free command execution after tokenizing the already-allowlisted command;
- a temporary copied repository as `cwd`;
- a hard wall-clock timeout and process-group kill;
- best-effort memory limits via `ulimit` for non-Windows hosts;
- host network denial where a local OS primitive is available.

This is light enough for a Node service because it does not require a Docker daemon, image management, per-run builds, or privileged container orchestration.

### Container per run

Run every verification in a disposable container with `--network=none`, a read-only image, a mounted temp repo, memory and CPU limits, and no injected secrets. This gives stronger filesystem and namespace isolation, especially on Linux, but it adds operational weight: image lifecycle, dependency availability, Docker/socket permissions, cold-start cost, and more failure modes in local development and CI.

## Decision

Use the locked-down child process approach now. It directly removes the largest current risk: ambient service privilege and inherited secrets. The verification subprocess env is explicitly constructed as `PATH` plus `PYTHONPATH`; it never spreads `process.env`. The JSDOM smoke runner is also moved out of the service process, so `runScripts: "dangerously"` executes in that same restricted child environment.

Network egress is denied on macOS with `sandbox-exec` using a profile that allows normal process and filesystem operations but denies `network*`. On hosts without an available network sandbox primitive, the runner still strips secrets and runs in a temp copy, but network denial is not guaranteed. The residual risk is that untrusted tests could make outbound requests on those hosts, though they no longer have service secrets in their environment. For production Linux deployments, the stronger follow-up is to run this same child process inside a container or worker namespace with network egress disabled by the orchestrator.

This is intentionally a step below full container isolation: the copied repo is the working directory, but it is not a hard filesystem jail. A malicious test could still try to read host files permitted to the service account. Container-per-run remains the right next step if untrusted verification needs a strict filesystem boundary in addition to env and network isolation.
