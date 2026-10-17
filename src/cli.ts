#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { ConfigError, Router, TIERS, type Tier, describe } from './core'
import { DEFAULT_RAW, type ProxyConfig, resolveProxyConfig } from './proxy/config'
import { bunIo, startProxy } from './proxy/server'

const HOME = homedir()
const USER_CONFIG = join(HOME, '.model-router', 'config.json')

const USAGE = `model-router: route each agent prompt to the cheapest model tier that gets it right

  model-router serve   [--config F] [--port N]   run the routing proxy
  model-router classify [--config F] [--router A] "prompt"   show what a prompt routes to
  model-router replay  [--config F] [--router A] <file.jsonl|dir>...   re-route logged asks, compare tiers
  model-router env     claude|copilot [--router A] [--port N]   print the env vars that point a CLI at the proxy
  model-router init    write the example config to ${USER_CONFIG}

Config: --config, $MODEL_ROUTER_CONFIG, ./model-router.json, ${USER_CONFIG}, else a built-in heuristic-only Anthropic router.`

const args = process.argv.slice(2)
const command = args.shift()
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)

  if (i < 0) {
    return undefined
  }

  const [value] = args.splice(i, 2).slice(1)

  return value
}

const loadConfig = (): { config: ProxyConfig; from: string } => {
  const path = [flag('config'), process.env.MODEL_ROUTER_CONFIG, resolve('model-router.json'), USER_CONFIG].find(
    p => p !== undefined && existsSync(p),
  )
  const raw = path === undefined ? DEFAULT_RAW : JSON.parse(readFileSync(path, 'utf8'))
  const config = resolveProxyConfig(raw, HOME)
  const port = flag('port')

  if (port !== undefined) {
    config.port = Number(port)
  }

  return { config, from: path ?? '(built-in defaults)' }
}

const pickRouter = (config: ProxyConfig) => {
  const alias = flag('router')
  const entry = alias === undefined ? config.routers[0] : config.routers.find(r => r.alias === alias)

  if (entry === undefined) {
    throw new ConfigError(`no router "${alias}" (have: ${config.routers.map(r => r.alias).join(', ')})`)
  }

  return entry
}

const classifyOne = async (router: Router, ask: string) =>
  router.route({ sessionId: `cli-${Math.random()}`, system: '', turns: [{ role: 'user', text: ask, hasToolResult: false }] })

const jsonlFiles = (paths: string[]): string[] =>
  paths.flatMap(p =>
    statSync(p).isDirectory()
      ? readdirSync(p).filter(f => f.endsWith('.json') || f.endsWith('.jsonl')).map(f => join(p, f))
      : [p],
  )

/** v2 records carry `ask`; the Claude Code mod's v1 records carry `prompt` and three-tier names. */
const V1: Record<string, Tier> = { haiku: 'simple', sonnet: 'medium', opus: 'complex' }

const main = async () => {
  switch (command) {
    case 'serve': {
      const { config, from } = loadConfig()
      const server = startProxy(config)

      console.log(`model-router listening on http://${server.hostname}:${server.port}  (config: ${from})`)

      for (const r of config.routers) {
        const tiers = TIERS.map(t => {
          const v = r.config.tiers[t]

          return v === undefined ? '' : `${t}=${(Array.isArray(v) ? v : [v]).map(x => x.model).join('|')}`
        }).filter(Boolean)

        console.log(`  ${r.alias} (${r.protocol} -> ${r.upstream.baseUrl})  ${tiers.join('  ')}`)
        console.log(`    classifiers: ${r.config.classifiers.map(c => (c.type === 'heuristic' ? 'heuristic' : `${c.type}:${c.model}`)).join(' -> ')}${r.config.classifiers.some(c => c.type === 'heuristic') ? '' : ' -> heuristic'}`)
      }

      console.log(`  decision log: ${config.log.mode === 'off' ? 'off' : `${config.log.dir} (${config.log.mode})`}`)

      return
    }

    case 'classify': {
      const { config } = loadConfig()
      const entry = pickRouter(config)
      const ask = args.join(' ') || (await Bun.stdin.text()).trim()
      const decision = await classifyOne(new Router(entry.config, bunIo), ask)

      console.log(decision === undefined ? 'policy is off: request goes unrouted' : describe(decision))

      if (decision?.why) {
        console.log(`why: ${decision.why}`)
      }

      return
    }

    case 'replay': {
      const { config } = loadConfig()
      const entry = pickRouter(config)
      const router = new Router(entry.config, bunIo)
      const matrix = new Map<string, number>()
      let n = 0

      for (const file of jsonlFiles(args)) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (line.trim() === '') {
            continue
          }

          const r = JSON.parse(line) as { ask?: string | null; prompt?: string | null; tier?: string | null; wantedTier?: string | null }
          const ask = r.ask ?? r.prompt

          if (!ask) {
            continue
          }

          const before = r.wantedTier ?? r.tier
          const was = before ? (V1[before] ?? before) : 'unrouted'
          const d = await classifyOne(router, ask)
          const now = d?.tier ?? 'unrouted'
          const key = `${was} -> ${now}`

          matrix.set(key, (matrix.get(key) ?? 0) + 1)
          n += 1
          console.log(`${was.padEnd(9)} -> ${now.padEnd(9)} ${d?.cause ?? ''}  ${ask.replace(/\s+/g, ' ').slice(0, 90)}`)
        }
      }

      console.log(`\n${n} asks re-routed with ${entry.alias}:`)

      for (const [k, v] of [...matrix].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k.padEnd(24)} ${v}`)
      }

      return
    }

    case 'env': {
      const host = args.shift()
      const { config } = loadConfig()
      const entry = pickRouter(config)
      const base = `http://${config.host}:${config.port}`

      if (host === 'claude') {
        if (entry.protocol !== 'anthropic') {
          throw new ConfigError(`${entry.alias} speaks ${entry.protocol}; Claude Code needs an anthropic router`)
        }

        console.log(
          [
            `export ANTHROPIC_BASE_URL=${base}`,
            `export ANTHROPIC_MODEL=${entry.alias}`,
            '# Subagents and background calls asking for real model ids pass through untouched.',
          ].join('\n'),
        )
      } else if (host === 'copilot') {
        const medium = entry.config.tiers.medium ?? Object.values(entry.config.tiers)[0]
        const known = Array.isArray(medium) ? medium[0]?.model : medium?.model

        console.log(
          [
            `export COPILOT_PROVIDER_BASE_URL=${base}`,
            `export COPILOT_PROVIDER_TYPE=${entry.protocol}`,
            `export COPILOT_MODEL=${entry.alias}`,
            `export COPILOT_PROVIDER_WIRE_MODEL=${entry.alias}`,
            `# Capabilities and token limits Copilot should assume (the routed models vary per turn):`,
            `export COPILOT_PROVIDER_MODEL_ID=${known ?? entry.alias}`,
            entry.upstream.apiKeyEnv
              ? `# The proxy adds the key from $${entry.upstream.apiKeyEnv}; Copilot needs none.`
              : `export COPILOT_PROVIDER_API_KEY=\${${entry.protocol === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}}  # passed through by the proxy`,
          ].join('\n'),
        )
      } else {
        throw new ConfigError('env: claude or copilot')
      }

      return
    }

    case 'init': {
      if (existsSync(USER_CONFIG)) {
        console.log(`${USER_CONFIG} exists; left alone.`)

        return
      }

      await mkdir(join(HOME, '.model-router'), { recursive: true })
      await writeFile(USER_CONFIG, readFileSync(new URL('../examples/model-router.json', import.meta.url), 'utf8'))
      console.log(`wrote ${USER_CONFIG}`)

      return
    }

    default:
      console.log(USAGE)
      process.exitCode = command === undefined || command === 'help' || command === '--help' ? 0 : 1
  }
}

main().catch(err => {
  console.error(err instanceof ConfigError ? `config error: ${err.message}` : err)
  process.exitCode = 1
})
