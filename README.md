# model-router

Routes each prompt an AI coding agent sends to the cheapest model tier that will still get it right, and picks a reasoning effort while it is there. One routing core, three ways in:

| Host | How it is routed | Model switch happens |
| --- | --- | --- |
| **Claude Code**, as a plugin | `turn.step` hook rewrites model and effort | in-process, per turn |
| **Claude Code**, through the proxy | `ANTHROPIC_BASE_URL` → local proxy | per request |
| **GitHub Copilot CLI** | BYOK env vars → local proxy | per request |
| Anything speaking Anthropic Messages, OpenAI Chat Completions or Responses | point its base URL at the proxy | per request |

Copilot CLI's [hooks](https://docs.github.com/en/copilot/reference/hooks-reference) cannot do this job. No hook can choose the model, and a command hook's `userPromptSubmitted` output is dropped. So Copilot is routed through its [BYOK provider settings](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models) instead, with the proxy acting as the provider.

**Setup steps:** see the [User Guide](docs/USER-GUIDE.md) (Claude Code, Copilot CLI, and both in VS Code).

## How a request is decided

The pipeline borrows LiteLLM's [Auto Routing](https://docs.litellm.ai/docs/proxy/auto_routing) design and adds cache-aware switching.

1. **Find the ask.** Under an agent harness, one turn is a large system prompt, a pile of tool results and a one-line ask. The router finds the newest user turn that still has human text once tool output, `<system-reminder>` blocks and mid-conversation `system` messages are set aside. "Fix this typo" and "refactor the auth subsystem" are each judged on their own words, not on the 40k-token prefix they share.
2. **Continuations keep the decision.** A tool-loop step (the newest message is tool output) reuses its turn's decision, with no classifier call. So does a harness message: a subagent hand-back, a task notification or a slash-command envelope inherits the conversation's tier.
3. **Keyword rules** short-circuit. When several rules match, the highest tier wins.
4. **Classifier chain**, tried in order, each with a timeout and a circuit breaker:
   - `decision`: a local decision model answers choice questions (LM Studio `/v1/decisions`, for example clef-flash). Nothing is billed and the prompt never leaves the machine. With `coverage`, the router picks the cheapest tier whose cumulative probability reaches it, so an unsure model lands higher.
   - `llm`: a cheap model (Haiku, gpt-5-mini, anything on an Anthropic or OpenAI-compatible API) returns `{tier, effort}`.
   - `heuristic`: seven weighted signals over the ask (length, code, reasoning markers, technical terms, simple indicators, multi-step, questions). It takes under a millisecond and costs nothing. It always comes last, so every request gets a decision. Two adjustments make it fit agent work: "yes, do it"-style follow-ups inherit the previous tier, and work verbs ("start on the P0 tasks") floor the tier at `medium`.
5. **Cap** at `maxTier`. **Vision**: a request with images skips targets marked `vision: false`.
6. **Cache-aware switch.** Each model has its own prompt cache, so a downgrade rereads the whole conversation at the cheaper model's cache-write price. Upgrades always happen. A downgrade happens only when the expected steps ahead repay that reread, judged from each target's `price`. On a warm, long chat Opus holds against Sonnet but drops to Haiku, and once the cache has gone cold anything goes.
7. **Context escalation.** When the prompt provably does not fit a target's `contextWindow`, the request moves up. A target with no declared window is never moved away from or onto.
8. **Effort.** The classifier's effort (or the target's default) is clamped to the target's `minEffort`/`maxEffort`. It is dropped for models that reject an effort parameter (`supportsEffort: false`).

Tiers are generic (`simple < medium < complex < reasoning`), and each one maps to one model or a random-pick pool. Mapping two tiers to the same model at different efforts is an *effort ladder*. That is often cheaper than jumping to a frontier model.

## Quick start: proxy

Requires [Bun](https://bun.sh) 1.1 or later.

```sh
bun install
bun src/cli.ts init      # writes ~/.model-router/config.json from examples/model-router.json
bun src/cli.ts serve     # http://127.0.0.1:4141
```

With no config file, the proxy starts one heuristic-only Anthropic alias, `claude-auto`.

Try the classifier without sending anything:

```sh
bun src/cli.ts classify "rename foo to bar in utils.ts"
# cause=heuristic tier=simple model=claude-haiku-4-5 score=-0.150 signals=[short (8 tokens), simple (rename)] ms=2
```

### Claude Code through the proxy

```sh
eval "$(bun src/cli.ts env claude)"   # ANTHROPIC_BASE_URL + ANTHROPIC_MODEL=claude-auto
claude
```

- Only requests that name the alias are routed. Subagents and background calls that name a real model id pass through untouched.
- With no `apiKeyEnv` on the upstream, the client's own auth headers are forwarded.
- Claude Code does not know the `claude-auto` alias. It warns, and auto-compacts at a 200k context. That limit is right when the `simple` tier is Haiku 4.5, whose window is 200k: every tier stays valid. If you have no 200k model in the tiers, set `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`.

### GitHub Copilot CLI through the proxy

```sh
eval "$(bun src/cli.ts env copilot --router claude-auto)"   # Anthropic wire
# or
eval "$(bun src/cli.ts env copilot --router auto)"          # OpenAI wire
copilot
```

This sets `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE`, `COPILOT_MODEL` and `COPILOT_PROVIDER_WIRE_MODEL` to the alias. It also sets `COPILOT_PROVIDER_MODEL_ID` to the medium-tier model, so Copilot assumes sensible capabilities and token limits. BYOK requires models that support tool calling and streaming, which every tier must therefore do.

## Quick start: Claude Code plugin

The plugin routes inside Claude Code. It needs no proxy, and its `claude` classifier uses Claude Code's own model call.

```sh
bun run build:plugin                     # bundles core + adapter into plugins/claude-code/hooks/register.js
claude --plugin-dir plugins/claude-code  # try it for one session
# or install from this repo as a marketplace: .claude-plugin/marketplace.json
```

Settings, in the plugin's config menu:

- `classifier`: `decision`, `claude` or `heuristic`
- `policy`
- the model for each tier
- `maxTier` and `maxEffort`
- the decision endpoint and its `coverage`
- the cache TTL
- the decision log

Subagents keep the model their definition chose.

> If you already run another routing mod (for example a local `model-router` in `~/.claude/mods`), enable only one of them. Two routers would each rewrite every turn.

## Config reference

`examples/model-router.json` is a complete, commented config with both an Anthropic router and an OpenAI-compatible one. Each entry in `routers`:

| Key | Default | Meaning |
| --- | --- | --- |
| `alias` | required | The model name clients ask for |
| `protocol` | required | `anthropic` or `openai` (Chat Completions and Responses) |
| `upstream.baseUrl` / `apiKeyEnv` | required / none | Where routed requests go, and which env var holds the key. Unset key: client auth passes through |
| `tiers` | required | `simple`/`medium`/`complex`/`reasoning` → target or list of targets. A missing tier borrows the nearest one above it, else below |
| target `model`, `effort`, `minEffort`, `maxEffort` | | The model and its effort bounds |
| target `supportsEffort` | `true` | `false` drops the effort parameter |
| target `thinking` | untouched | `adaptive`, `budget` (converts adaptive thinking to a token budget) or `none` (strips it) |
| target `vision`, `contextWindow`, `price` | | Used by vision routing, context escalation and the cache-aware policy (`price` is USD per MTok: `input`, `output`, `cacheWrite`, `cacheRead`) |
| `classifiers` | `[heuristic]` | The chain. The heuristic is appended if it is missing |
| `keywordRules` | `[]` | `{keywords, tier}` |
| `policy` | `cache-aware` | `cache-aware`, `always`, `effort-only` or `off` |
| `cacheTtlMs`, `expectedSteps` | 5 min, 6 | Inputs to the downgrade calculation |
| `classificationMode` | `user_turn` | `every_request` classifies tool-loop steps too |
| `sessionAffinity` | `false` | Pins a conversation to its first tier |
| `contextEscalation` | off (on in the example config) | `{enabled, buffer}` |
| `maxTier`, `defaultTier` | `reasoning`, `medium` | |
| `reminderMarkers`, `inheritPrefixes` | Claude Code's | Harness envelopes to strip, and envelopes to inherit |
| `context` | 3 turns, 8000 chars | Prior turns the LLM and decision classifiers see. Assistant turns are included, so a "yes" to "here's the plan, it's complex, go ahead?" is judged against the plan |

Top level: `host`, `port`, `log.mode` (`off`/`metadata`/`full`; `full` includes the ask, clipped), `log.dir` (default `~/.model-router/decisions`), and `passthrough.{anthropic,openai}` for requests that name other models.

## Measuring and tuning

Every routed request writes one JSONL row: cause, wanted and final tier, model, effort, held or escalated, the classifier failures it fell through, classifier latency, and the provider's token usage read from the response stream. The proxy also prints one greppable line per decision:

```
model-router [claude-auto] cause=heuristic tier=simple model=claude-haiku-4-5 score=-0.150 signals=[short (5 tokens), simple (rename)] ms=1
```

`replay` re-routes logged asks under the current config and prints a confusion table. It reads this tool's logs and the v1 logs of the original Claude Code mod:

```sh
bun src/cli.ts replay ~/.model-router/decisions
```

## Development

```sh
bun test             # core, wire formats, proxy end to end against a fake upstream
bun run typecheck    # needs src/adapters/claude-code/claude-code.d.ts (see .gitignore)
bun run test:plugin  # builds, validates and runs the plugin's tests under `claude plugin test`
```

```
src/core/      host-agnostic: extract, heuristic, classifiers, policy, router, log (I/O injected through `Io`)
src/wire/      Anthropic Messages and OpenAI Chat/Responses <-> core
src/proxy/     Bun HTTP proxy (streaming passthrough, usage capture)
src/adapters/  claude-code: the plugin source
plugins/       claude-code: the built plugin
```

## Limitations

- Each proxy alias has one upstream and one wire protocol, with no translation between protocols. To mix providers inside one alias, point `upstream` at a gateway such as LiteLLM.
- Conversation state lives in process memory, so a restart starts every conversation cold. That costs at most one unneeded switch.
- Switching models mid-conversation loses thinking blocks: other models drop the blocks they did not produce. `sessionAffinity: true` avoids this, at the cost of keeping the first turn's tier.
- The heuristic is a floor, not a judge. Terse, high-stakes asks need the `decision` or `llm` classifier.
- Not yet built: Thompson-sampled adaptive pools, and computing savings against a baseline model.
