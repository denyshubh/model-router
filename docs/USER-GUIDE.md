# model-router: User Guide

This guide is written in Simplified Technical English (ASD-STE100 style): short sentences, one instruction in each step.

## 1. General

1.1. model-router sends each prompt to the cheapest model that can do the task.

1.2. It operates in two modes:

| Mode | Use it with |
| --- | --- |
| **Proxy** | Claude Code, GitHub Copilot CLI, GitHub Copilot in VS Code, the Claude Code extension in VS Code |
| **Plugin** | Claude Code only (terminal or VS Code extension). The plugin does not need the proxy. |

1.3. Each routing decision has a tier. There are four tiers:

| Tier | Task type | Default model |
| --- | --- | --- |
| `simple` | Rename, format, one fact, small edit | `claude-haiku-4-5` |
| `medium` | Feature, bug fix, tests, explanation | `claude-sonnet-5-5` |
| `complex` | Large refactor, subtle bug, migration | `claude-opus-5-5` |
| `reasoning` | Architecture, design, deep analysis | `claude-opus-5-5`, effort `high` |

## 2. Requirements

2.1. Install Bun 1.1 or later:

```sh
curl -fsSL https://bun.sh/install | bash
```

2.2. Get an API key for each provider that you use. Examples: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.

2.3. Optional: install LM Studio and load a decision model (for example, `clef-flash`). With it, classification is free and stays on your computer.

> **NOTE:** If the decision model is not available, the router uses its heuristic. Each prompt still gets a decision.

## 3. Install and start the proxy

Do this procedure for all proxy setups (sections 5, 6, 7 and 8).

3.1. Go to the project folder:

```sh
cd model-router
```

3.2. Install the dependencies:

```sh
bun install
```

3.3. Make the configuration file:

```sh
bun src/cli.ts init
```

3.4. Open `~/.model-router/config.json`.

3.5. Make sure that the model names in `tiers` are models that your account can use.

3.6. Set your API key in the shell:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
```

3.7. Start the proxy:

```sh
bun src/cli.ts serve
```

3.8. Make sure that the output shows `model-router listening on http://127.0.0.1:4141`.

3.9. Keep this terminal open. The proxy must operate while you work.

> **CAUTION:** Do not change `host` to `0.0.0.0`. The proxy has no authentication. Other computers on your network could then use your API key.

## 4. Claude Code in the terminal: plugin method

Use this method if you use Claude Code only. You do not need the proxy.

> **WARNING:** Use one router only. If another routing plugin is on, disable it first. Two routers change each turn twice.

4.1. Build the plugin:

```sh
bun run build:plugin
```

4.2. Add the project folder as a plugin marketplace:

```sh
claude plugin marketplace add /path/to/model-router
```

4.3. Install the plugin:

```sh
claude plugin install model-router@model-router
```

4.4. Start Claude Code:

```sh
claude
```

4.5. Type `/plugin` and select **model-router** to change its settings.

4.6. Set `classifier` to one of these values:

| Value | Result |
| --- | --- |
| `decision` | LM Studio decides. Free. The prompt stays on your computer. |
| `claude` | A Claude model decides. Small cost for each prompt. |
| `heuristic` | Keyword scoring. Free and instant. Less accurate. |

4.7. Send a prompt.

4.8. Look at the status line. It shows the routing decision, for example `route simple·haiku-4-5`.

> **NOTE:** To try the plugin for one session only, do not do steps 4.2 and 4.3. Start Claude Code with `claude --plugin-dir /path/to/model-router/plugins/claude-code`.

## 5. Claude Code in the terminal: proxy method

5.1. Do the procedure in section 3.

5.2. Open a new terminal.

5.3. Set the environment variables:

```sh
eval "$(bun /path/to/model-router/src/cli.ts env claude)"
```

5.4. Start Claude Code:

```sh
claude
```

5.5. Look at the proxy terminal. Each new prompt shows one line that starts with `model-router [claude-auto] cause=`.

> **NOTE:** At start, Claude Code shows a warning that it does not know `claude-auto`. This is correct. Claude Code then keeps the context below 200k tokens, which is safe for all tiers.

## 6. Claude Code in VS Code

6.1. Install the **Claude Code** extension in VS Code.

6.2. Select one method:

- **Plugin method:** go to step 6.3.
- **Proxy method:** go to step 6.5.

**Plugin method**

6.3. Do steps 4.1 to 4.3. The extension and the terminal use the same plugins.

6.4. Go to step 6.8.

**Proxy method**

6.5. Do the procedure in section 3.

6.6. In VS Code, open **Settings (JSON)**: from the Command Palette, run **Preferences: Open User Settings (JSON)**.

6.7. Add these values:

```json
{
  "claudeCode.environmentVariables": [
    { "name": "ANTHROPIC_BASE_URL", "value": "http://127.0.0.1:4141" },
    { "name": "ANTHROPIC_MODEL", "value": "claude-auto" }
  ]
}
```

> **NOTE:** This setting applies to the VS Code extension only. To route the terminal too, put the same two values in the `env` block of `~/.claude/settings.json`.

**Both methods**

6.8. Fully quit VS Code, then start it again.

6.9. Open the Claude Code panel. Send a prompt.

6.10. Make sure that the routing decision is shown. For the plugin, look at the status line. For the proxy, look at the proxy terminal.

## 7. GitHub Copilot CLI

> **NOTE:** Copilot CLI hooks cannot change the model. Use the proxy.

7.1. Do the procedure in section 3.

7.2. Open a new terminal.

7.3. Set the environment variables. Use the Anthropic router:

```sh
eval "$(bun /path/to/model-router/src/cli.ts env copilot --router claude-auto)"
```

Or use the OpenAI router:

```sh
eval "$(bun /path/to/model-router/src/cli.ts env copilot --router auto)"
```

7.4. Start Copilot CLI:

```sh
copilot
```

7.5. Send a prompt.

7.6. Look at the proxy terminal. Make sure that a `model-router [...] cause=` line is shown.

> **CAUTION:** All models in the router must support tool calling and streaming. Copilot CLI fails with a model that does not support them.

## 8. GitHub Copilot in VS Code

> **NOTE:** For Copilot Business or Enterprise, an administrator must enable the policy **Bring Your Own Language Model Key**.

8.1. Do the procedure in section 3.

8.2. In VS Code, open the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows and Linux).

8.3. Run **Chat: Manage Language Models**.

8.4. Select **Add Models**, then select **Custom Endpoint**.

8.5. In `chatLanguageModels.json`, add this entry:

```json
[
  {
    "name": "model-router",
    "vendor": "customendpoint",
    "apiKey": "${input:modelRouterKey}",
    "apiType": "messages",
    "models": [
      {
        "id": "claude-auto",
        "name": "Auto (model-router)",
        "url": "http://127.0.0.1:4141/v1/messages",
        "toolCalling": true,
        "vision": true,
        "maxInputTokens": 200000,
        "maxOutputTokens": 32000
      }
    ]
  }
]
```

8.6. To use the OpenAI router, make these changes:

| Field | Value |
| --- | --- |
| `apiType` | `chat-completions` |
| `id` | `auto` |
| `url` | `http://127.0.0.1:4141/v1/chat/completions` |

8.7. Save the file.

8.8. When VS Code asks for the key, type your API key. If `apiKeyEnv` is set in the proxy configuration, type any text. The proxy then adds the key.

8.9. Open the Chat view.

8.10. In the model picker, select **Auto (model-router)**.

8.11. Send a prompt. Look at the proxy terminal for the routing line.

8.12. Optional: to use the router in agent mode, set `chat.agentHost.byokModels.enabled` to `true`. This setting is experimental.

> **NOTE:** Some features still use GitHub models: code completions, semantic search and embeddings. The router does not change these.

## 9. Check the routing

9.1. Test a prompt without sending it to a model:

```sh
bun src/cli.ts classify "rename foo to bar"
```

9.2. Make sure that the output shows `tier=simple`.

9.3. Test a difficult prompt:

```sh
bun src/cli.ts classify "Think through the trade-offs of sharding and analyze the risks"
```

9.4. Make sure that the output shows `tier=reasoning`.

9.5. To compare the past decisions with the current configuration:

```sh
bun src/cli.ts replay ~/.model-router/decisions
```

## 10. Stop the router

10.1. Proxy: in the proxy terminal, push `Ctrl+C`.

10.2. Terminal tools: open a new terminal. The `eval` variables apply only to the terminal that set them.

10.3. Claude Code in VS Code: remove the values that you added in step 6.7, or run `claude plugin uninstall model-router@model-router`. Start VS Code again.

10.4. Copilot in VS Code: in the model picker, select a different model.

> **CAUTION:** If you stop the proxy while a client still points to it, all prompts fail. Stop the client first, or remove its settings.

## 11. Troubleshooting

| Problem | Possible cause | Action |
| --- | --- | --- |
| `upstream unreachable` | No network, or `baseUrl` is incorrect | Examine `upstream.baseUrl` in the configuration. |
| `401` or `403` | API key is missing or incorrect | Set the key in the terminal that started the proxy (step 3.6). Start the proxy again. |
| `unknown model` | The client sends an alias that is not in the configuration | Make the client model the same as the `alias` value. |
| `400` from the provider | A model does not accept a parameter | For that tier, set `supportsEffort: false` or `thinking: "none"`. |
| All prompts go to the same tier | The heuristic is the only classifier | Start LM Studio, or add an `llm` classifier. |
| `fallback_after=[decision:...]` in the log | LM Studio is not available | Start LM Studio and load the decision model. Or remove the `decision` classifier. |
| No status line in Claude Code | The plugin did not load | Do step 4.1 again. Then start Claude Code with `--debug` and read the log. |
| `claude-auto` is not in the `/model` picker | Claude Code shows only gateway models whose names contain `claude` | This is correct. The model is set by `ANTHROPIC_MODEL`. Do not select another model. |
| Copilot CLI shows a model error | A model does not support tool calling or streaming | Replace that model in `tiers`. |
| Copilot model is not in the VS Code picker | The organization policy is off | Speak to your administrator (see the note in section 8). |
