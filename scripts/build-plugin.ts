/**
 * Bundles the Claude Code adapter and the core into one module inside the
 * plugin folder (a plugin may import only its own files), then reshapes the
 * export: Claude Code's validator reads `register` as a function exported
 * where it is declared, not through a trailing `export { register }`.
 */
const out = 'plugins/claude-code/hooks/register.js'
const result = await Bun.build({
  entrypoints: ['src/adapters/claude-code/register.ts'],
  format: 'esm',
  target: 'browser',
  external: ['claude-code'],
})

if (!result.success) {
  console.error(result.logs.join('\n'))
  process.exit(1)
}

let code = await result.outputs[0]!.text()
const exportList = /\nexport \{\s*register\s*\};?\s*$/

if (!exportList.test(code) || !/\nvar register = /.test(code)) {
  console.error('build-plugin: unexpected bundle shape; check how `register` is emitted')
  process.exit(1)
}

code = code.replace(exportList, '\n').replace(/\nvar register = /, '\nexport const register = ')

await Bun.write(out, `// Generated from src/adapters/claude-code by \`bun run build:plugin\`. Do not edit.\n${code}`)
console.log(`wrote ${out} (${(code.length / 1024).toFixed(1)} KB)`)
