import { type LogMode, type RouterConfig, ConfigError, isLogMode, resolveConfig } from '../core'

export type Protocol = 'anthropic' | 'openai'

export type Upstream = {
  /** Anthropic: `https://api.anthropic.com`. OpenAI-compatible: the base that `/chat/completions` hangs off. */
  baseUrl: string
  /** Env var with the key. Unset: the client's own auth headers are passed through. */
  apiKeyEnv?: string
}

/** One routed alias: clients ask for `alias` as the model, the router picks the real one. */
export type RouterEntry = {
  alias: string
  protocol: Protocol
  upstream: Upstream
  config: RouterConfig
}

export type ProxyConfig = {
  host: string
  port: number
  log: { mode: LogMode; dir: string }
  routers: RouterEntry[]
  /** Where requests naming any other model go, per protocol; defaults to the first router's upstream. */
  passthrough: Partial<Record<Protocol, Upstream>>
}

type RawEntry = Partial<RouterConfig> & {
  alias?: string
  protocol?: Protocol
  upstream?: Upstream
  [k: string]: unknown
}

export const resolveProxyConfig = (
  raw: { host?: string; port?: number; log?: { mode?: string; dir?: string }; routers?: RawEntry[]; passthrough?: ProxyConfig['passthrough'] },
  home: string,
): ProxyConfig => {
  const routers = (raw.routers ?? []).map((entry, i): RouterEntry => {
    const { alias, protocol, upstream, ...rest } = entry

    if (typeof alias !== 'string' || alias === '') {
      throw new ConfigError(`routers[${i}].alias: required`)
    }

    if (protocol !== 'anthropic' && protocol !== 'openai') {
      throw new ConfigError(`routers[${i}].protocol: anthropic or openai`)
    }

    if (typeof upstream?.baseUrl !== 'string') {
      throw new ConfigError(`routers[${i}].upstream.baseUrl: required`)
    }

    try {
      return { alias, protocol, upstream, config: resolveConfig(rest) }
    } catch (err) {
      throw err instanceof ConfigError ? new ConfigError(`routers[${i}] (${alias}): ${err.message}`) : err
    }
  })

  if (routers.length === 0) {
    throw new ConfigError('routers: configure at least one')
  }

  const aliases = new Set<string>()

  for (const r of routers) {
    if (aliases.has(r.alias)) {
      throw new ConfigError(`routers: alias "${r.alias}" is used twice`)
    }

    aliases.add(r.alias)
  }

  const mode = raw.log?.mode ?? 'metadata'

  if (!isLogMode(mode)) {
    throw new ConfigError('log.mode: off, metadata or full')
  }

  return {
    host: raw.host ?? '127.0.0.1',
    port: raw.port ?? 4141,
    log: { mode, dir: raw.log?.dir ?? `${home}/.model-router/decisions` },
    routers,
    passthrough: raw.passthrough ?? {},
  }
}

/**
 * List prices, USD per million tokens, 5-minute cache writes (1.25x input).
 * Check them against the provider's pricing page before relying on the
 * cache-aware policy; a target without a price always switches.
 */
const PRICES = {
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  opus: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
}

/** Used when no config file is found: one Anthropic alias, heuristic only, nothing billed to classify. */
export const DEFAULT_RAW = {
  routers: [
    {
      alias: 'claude-auto',
      protocol: 'anthropic' as const,
      upstream: { baseUrl: 'https://api.anthropic.com' },
      tiers: {
        simple: { model: 'claude-haiku-4-5', supportsEffort: false, thinking: 'budget' as const, contextWindow: 200_000, price: PRICES.haiku },
        medium: { model: 'claude-sonnet-5-5', effort: 'medium' as const, contextWindow: 1_000_000, price: PRICES.sonnet },
        complex: { model: 'claude-opus-5-5', effort: 'medium' as const, contextWindow: 1_000_000, price: PRICES.opus },
        reasoning: { model: 'claude-opus-5-5', effort: 'high' as const, minEffort: 'high' as const, contextWindow: 1_000_000, price: PRICES.opus },
      },
      contextEscalation: { enabled: true, buffer: 0.95 },
      classifiers: [{ type: 'heuristic' as const }],
    },
  ],
}
