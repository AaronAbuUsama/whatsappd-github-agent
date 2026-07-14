# CLI parser options for the application executable

Status: research snapshot, 2026-07-14

## Recommendation

Use **Commander 15 through `@commander-js/extra-typings` for command parsing**, and use **`@clack/prompts` only inside commands that need guided interaction**.

That pairing gives this application the clearest production boundary:

```ts
// argv, commands, options, help, and exit behavior
import { Command } from "@commander-js/extra-typings";

// interactive setup questions, progress, and cancellation
import * as prompts from "@clack/prompts";
```

Commander is larger than citty or CAC, but this is a long-running application rather than a size-sensitive library. Its strict parsing, mature nested-command model, generated help, spelling suggestions, controllable output and exits, and direct test seams are worth roughly 200 KiB of unpacked package content. `@commander-js/extra-typings` adds definition-driven inference for `.opts()` and `.action()` instead of accepting `any` at the command boundary.

There is one compatibility action: Commander 15 declares Node `>=22.12.0`, while this repository currently declares Node `>=22`. Adoption should make the application floor honest by changing the repository engine to at least `>=22.12.0` (or the higher runtime floor independently required by the rest of the application). Do not silently claim support for Node 22.0–22.11.

## Current application boundary

The current package is already ESM and TypeScript, but it has no executable entry and its `start` script bypasses a lifecycle CLI:

```json
{
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "start": "node --env-file-if-exists=.env dist/server.mjs"
  }
}
```

Source: [`package.json`](../../package.json).

The target surface is small but user-facing: `init`, `start`, `status`, `config`, and `doctor`, plus useful root help and automatic first-run guidance. The parser should therefore optimize for predictable errors, help, typed command handlers, and deterministic tests—not for implementing an interactive terminal UI. Clack owns the latter.

## Comparison

The package facts below come from the publishers' npm registry metadata and source repositories as of 2026-07-14. “Unpacked” is `dist.unpackedSize`, not a measured bundled application size.

| Criterion | Commander 15 + extra typings | citty 0.2.2 | CAC 7.0.0 |
|---|---|---|---|
| Module/runtime | ESM; Node `>=22.12.0` | ESM; no `engines` declaration in the published package | ESM; Node `>=20.19.0` |
| Subcommands | Attached or stand-alone subcommands; attached commands can be composed recursively | Recursively nested subcommands; first-class lazy/async command loading | Git-style command registrations and command-specific options; sufficient for this flat command set, but no first-class recursive command tree in its documented API |
| Typed options | Base package exposes TypeScript declarations but does not infer every fluent definition; `@commander-js/extra-typings` adds inferred options and action parameters | Strong inference is built into `defineCommand()`; string, boolean, enum, and positional definitions flow into `run({ args })` | Written in TypeScript, but the public `Options` index signature and action callback parameters are `any`; weakest command-boundary inference here |
| Help | Automatic `-h/--help`, default `help` command for subcommands, wrapping, groups, custom text and formatting | Automatically handles `-h/--help` and renders generated usage; supports hidden commands and aliases | Generated help and version are opt-in through `cli.help()` / `cli.version()`; help sections can be post-processed |
| Errors | Strict unknown-option errors, typo suggestions, optional help-after-error, structured `CommanderError`, output and exit overrides | `runMain()` catches errors, renders usage for CLI errors, prints the error, and calls `process.exit(1)` | Validation and unknown-option errors; documented global handling separates `parse(..., { run: false })` from `runMatchedCommand()` inside `try/catch` |
| Async handlers | `parseAsync()` | Async command, setup, cleanup, plugin, and lazy resolution | `runMatchedCommand()` can be awaited when the action returns a promise |
| Unit-test seam | Parse an injected user argv; `exitOverride()` prevents termination; `configureOutput()` captures stdout/stderr | `runCommand()` accepts raw argv and returns a result; `renderUsage()` returns a string. Avoid `runMain()` in unit tests because it exits | Parse injected argv without running, then invoke the matched action separately; console output still needs capturing/spying |
| Installed dependency shape | `commander` has zero runtime dependencies. Extra typings depends on the matching Commander line | Zero runtime dependencies | Zero installed runtime dependencies; `mri` is inlined into the published build |
| Published unpacked size | 207,368 B for Commander + 53,652 B for extra typings | 34,558 B | 41,198 B |
| Maintenance signal | v15.0.0 published 2026-05-29; extensive repository test and type-check suites | Three 0.2.x releases from January through April 2026; repository runs Vitest coverage and type tests | v7.0.0 published 2026-02-27 after the 6.7.x line; repository runs Vitest and type checking |

Primary sources:

- Commander: [README and API](https://github.com/tj/commander.js/blob/master/Readme.md), [v15 package manifest](https://github.com/tj/commander.js/blob/master/package.json), [npm registry metadata](https://registry.npmjs.org/commander/latest), and [`@commander-js/extra-typings`](https://github.com/commander-js/extra-typings).
- citty: [README and API](https://github.com/unjs/citty), [package manifest](https://github.com/unjs/citty/blob/main/package.json), [command runner source](https://github.com/unjs/citty/blob/main/src/command.ts), [main-process behavior](https://github.com/unjs/citty/blob/main/src/main.ts), and [npm registry metadata](https://registry.npmjs.org/citty/latest).
- CAC: [README and API](https://github.com/cacjs/cac), [package manifest](https://github.com/cacjs/cac/blob/main/package.json), and [npm registry metadata](https://registry.npmjs.org/cac/latest).

## Concrete shapes

### Commander

```ts
import { Command } from "@commander-js/extra-typings";

export function createCli(dependencies: CliDependencies) {
  const program = new Command()
    .name("ambient-agent")
    .description("Configure and run Ambient Agent")
    .showHelpAfterError("Run with --help for usage.");

  program.addCommand(createInitCommand(dependencies));
  program.addCommand(createStartCommand(dependencies));
  program.addCommand(createStatusCommand(dependencies));
  program.addCommand(createConfigCommand(dependencies));
  program.addCommand(createDoctorCommand(dependencies));

  return program;
}

await createCli(dependencies).parseAsync(process.argv);
```

The same factory is directly testable:

```ts
const stdout: string[] = [];
const cli = createCli(fakeDependencies)
  .exitOverride()
  .configureOutput({ writeOut: (text) => stdout.push(text) });

await cli.parseAsync(["status"], { from: "user" });
```

This cleanly supports one command module per lifecycle operation, so command implementation can proceed in parallel without sharing parser state.

### citty

```ts
import { defineCommand, runMain } from "citty";

const command = defineCommand({
  meta: { name: "ambient-agent", version: "0.1.0" },
  subCommands: {
    init: () => import("./commands/init.js").then((module) => module.default),
    start: () => import("./commands/start.js").then((module) => module.default),
    status: () => import("./commands/status.js").then((module) => module.default),
    config: () => import("./commands/config.js").then((module) => module.default),
    doctor: () => import("./commands/doctor.js").then((module) => module.default),
  },
});

await runMain(command);
```

citty is the strongest alternative. It is substantially smaller, its command-definition types are excellent, and lazy command modules make parallel development natural. Its tradeoff is the public application shell: `runMain()` owns console output and calls `process.exit()`, while custom test and embedding scenarios should drop down to `runCommand()` and `renderUsage()`. That is workable, but less explicit and customizable than Commander for the executable's outer boundary.

### CAC

```ts
import { cac } from "cac";

const cli = cac("ambient-agent");
cli.command("init", "Configure the application").action(runInit);
cli.command("start", "Run in the foreground").action(runStart);
cli.command("status", "Show application status").action(runStatus);
cli.command("config", "Change configuration").action(runConfig);
cli.command("doctor", "Check dependencies and credentials").action(runDoctor);
cli.help();
cli.version("0.1.0");
cli.parse();
```

CAC is lean and its flat command API is enough for the current list. The decisive drawback is type integrity: its published declarations type command action parameters and parsed option values as `any`. This application is intentionally moving configuration and runtime ownership behind a validated seam, so weakening types exactly at the user-input boundary is the wrong trade.

## Rubric

Scores are out of 5 and assess this repository's lifecycle CLI, not general library quality.

| Option | Floor-first | Reversibility | Blast radius | Correctness / integrity | Parallelizability | Existing fit | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| Commander 15 + extra typings | 5 | 4 | 4 | 5 | 5 | 4 | **27/30** |
| citty 0.2.2 | 5 | 5 | 5 | 4 | 5 | 5 | **29/30** |
| CAC 7.0.0 | 4 | 5 | 5 | 3 | 4 | 5 | **26/30** |

citty wins the mechanical score on size, native typing, and ESM fit. Commander remains the recommendation because correctness here includes stable user-facing help/error behavior and deterministic control of output and termination, not just parsed-value types. Those outer-shell capabilities are the part we would otherwise have to build and maintain ourselves. The engine-floor adjustment is explicit and local; changing parsers later remains straightforward because command actions should call application services rather than contain runtime construction.

## Clack's role

Clack is not one of the parser options. Its own project describes `@clack/prompts` as “opinionated, ready-to-use prompt components” and `@clack/core` as headless prompt primitives. It provides interactive controls such as text input, selection, confirmation, groups, progress, and cancellation—not an argv grammar, subcommand router, or generated command-help system. See the [Clack repository](https://github.com/bombshell-dev/clack), [official getting-started guide](https://bomb.sh/docs/clack/basics/getting-started/), and [published package metadata](https://registry.npmjs.org/@clack/prompts/latest).

Use it behind an interactivity check:

```ts
async function runInit(options: { nonInteractive?: boolean }) {
  if (options.nonInteractive || !process.stdin.isTTY || !process.stdout.isTTY) {
    return runNonInteractiveInit(options);
  }

  return runGuidedInitWithClack();
}
```

This preserves reliable automation and remote process-manager behavior while giving humans the guided setup experience. Parsing happens first; prompts happen only after a command has been selected and validated.

## `bin` and `npx`

Parser choice does not make a package executable. npm creates executable shims from the package's `bin` field, and `npm exec`/`npx` selects that declared binary. The application still needs a compiled entry with a Node shebang and a manifest mapping, for example:

```json
{
  "bin": {
    "ambient-agent": "./dist/cli.mjs"
  }
}
```

```js
#!/usr/bin/env node
```

All three parsers work behind such an entry. Commander also supports stand-alone executable subcommands, but this application should begin with in-process command modules: one `npx` package, one process, one validated runtime seam. See npm's official [`package.json` `bin` documentation](https://docs.npmjs.com/files/package.json/#bin) and [`npm exec` binary-selection rules](https://docs.npmjs.com/cli/v11/commands/npm-exec/).

The current package is also marked `"private": true`; a public `npx <package-name>` distribution path requires a publishable package (or a separate publishable CLI package). That distribution decision is independent of the parser and should not be hidden inside this choice.

## Adoption constraints

1. Add `@commander-js/extra-typings` and `@clack/prompts` as runtime dependencies.
2. Declare Node `>=22.19.0`, the higher effective floor required by the current Flue runtime and CLI.
3. Export a `createCli(dependencies)` factory; keep `process.argv`, console wiring, and exit-code ownership in the tiny executable entry.
4. Put each lifecycle command in its own module and have actions call application services.
5. Use Clack only in TTY-guided paths; every operational command must retain deterministic non-interactive behavior.
6. Test command selection, invalid args, generated help, exit codes, and stdout/stderr separately from the guided prompt flow.
