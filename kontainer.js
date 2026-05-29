#!/usr/bin/env node
'use strict'
// kontainer — minimal container runtime from scratch.
// No Docker. Uses Linux namespaces (user/pid/mount/uts/ipc) + cgroup v2.

const fs      = require('fs')
const path    = require('path')
const os      = require('os')
const store   = require('./store')
const images  = require('./images')
const runtime = require('./runtime')

// ── ANSI ──────────────────────────────────────────────────────────────────────

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  cyan:    '\x1b[36m',
  magenta: '\x1b[35m',
  gray:    '\x1b[90m',
}

function fmt(text, ...colors) {
  return colors.join('') + text + C.reset
}

function formatBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB'
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB'
  return b + ' B'
}

function formatAge(iso) {
  const secs = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (secs < 60)   return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs/60)}m ago`
  if (secs < 86400) return `${Math.floor(secs/3600)}h ago`
  return `${Math.floor(secs/86400)}d ago`
}

function table(headers, rows, colors = {}) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] || '').replace(/\x1b\[[0-9;]*m/g, '').length)))
  const sep    = widths.map(w => '─'.repeat(w + 2)).join('┼')
  const fmt    = (cells, rowColors) => cells.map((c, i) => {
    const str  = String(c || '').padEnd(widths[i])
    const col  = rowColors && rowColors[i] ? rowColors[i] : ''
    return ` ${col}${str}${col ? C.reset : ''} `
  }).join('│')

  console.log(fmt(headers.map((h, i) => h.padEnd(widths[i])).join('│').split('│').map(s => ` ${C.bold}${s.trim().padEnd(widths[headers.indexOf(s.trim())] || 10)}${C.reset} `).join('│')))
  console.log('─' + sep.replace(/┼/g, '┼') + '─')

  // Simpler approach
  const headerLine = '  ' + headers.map((h, i) => fmt(h.padEnd(widths[i]), C.bold, C.cyan)).join('  ')
  const divider    = '  ' + widths.map(w => '─'.repeat(w)).join('  ')
  process.stdout.write('\r')
  console.log(headerLine)
  console.log(divider)
  for (const row of rows) {
    const cols = row.map((c, i) => {
      const str = String(c || '')
      const col = colors[i] ? colors[i](str) : str
      const pad = widths[i] - str.replace(/\x1b\[[0-9;]*m/g, '').length
      return col + ' '.repeat(Math.max(0, pad))
    })
    console.log('  ' + cols.join('  '))
  }
}

function printTable(headers, rows, colorFns = {}) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => String(r[i] || '').replace(/\x1b\[[0-9;]*m/g, '').length))
  )

  const headerLine = headers.map((h, i) => fmt(h.padEnd(widths[i]), C.bold, C.cyan)).join('  ')
  const divider    = widths.map(w => '─'.repeat(w)).join('  ')

  console.log('  ' + headerLine)
  console.log('  ' + divider)
  for (const row of rows) {
    const cells = row.map((cell, i) => {
      const str  = String(cell ?? '')
      const raw  = str.replace(/\x1b\[[0-9;]*m/g, '')
      const pad  = ' '.repeat(Math.max(0, widths[i] - raw.length))
      const disp = colorFns[i] ? colorFns[i](str) : str
      return disp + pad
    })
    console.log('  ' + cells.join('  '))
  }
}

// ── Status colour ─────────────────────────────────────────────────────────────

function statusColor(status) {
  if (status === 'running') return fmt(status, C.green)
  if (status === 'exited')  return fmt(status, C.gray)
  if (status === 'stopped') return fmt(status, C.yellow)
  return status
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmd_run(args) {
  const opts = { env: {}, cmd: [], rm: false }
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (a === '--name')   { opts.name   = args[++i] }
    else if (a === '--memory') { opts.memory = args[++i] }
    else if (a === '--cpus')   { opts.cpus   = args[++i] }
    else if (a === '--rm')     { opts.rm     = true }
    else if (a === '--env') {
      const [k, v] = args[++i].split('=')
      opts.env[k] = v || ''
    }
    else if (!opts.image) { opts.image = a }
    else                  { opts.cmd.push(a) }
    i++
  }

  if (!opts.image) {
    console.error(fmt('error: image name required', C.red))
    console.error('Usage: kontainer run [--name <n>] [--memory 128m] [--cpus 0.5] [--env K=V] [--rm] <image> [cmd...]')
    process.exit(1)
  }

  console.log(fmt(`  Running image '${opts.image}'...`, C.dim))
  if (opts.memory) console.log(fmt(`  Memory limit: ${opts.memory}`, C.dim))
  if (opts.cpus)   console.log(fmt(`  CPU limit: ${opts.cpus}`, C.dim))

  const result = await runtime.run(opts)
  console.log(fmt(`  Container '${result.name}' exited (code ${result.exitCode})`, result.exitCode === 0 ? C.green : C.yellow))
  console.log(fmt(`  Logs: kontainer logs ${result.name}`, C.dim))
}

function cmd_ps(args) {
  const all        = args.includes('-a') || args.includes('--all')
  const containers = store.listContainers()
  const shown      = all ? containers : containers.filter(c => c.status === 'running')

  if (!shown.length) {
    console.log(fmt('  No containers' + (all ? '' : ' running. Use -a to show all.'), C.dim))
    return
  }

  console.log()
  printTable(
    ['NAME', 'IMAGE', 'COMMAND', 'STATUS', 'CREATED', 'PID'],
    shown.map(c => [
      c.name,
      c.image,
      (c.cmd || '').slice(0, 20),
      c.status,
      formatAge(c.created),
      c.pid || '-',
    ]),
    { 3: statusColor }
  )
  console.log()
}

function cmd_images() {
  const imgs = images.list()
  if (!imgs.length) {
    console.log(fmt('  No images. Run: kontainer build <dir> <name>', C.dim))
    return
  }
  console.log()
  printTable(
    ['NAME', 'CREATED', 'SIZE'],
    imgs.map(img => [img.name, formatAge(img.created), formatBytes(img.size)]),
    { 0: s => fmt(s, C.cyan) }
  )
  console.log()
}

function cmd_logs(name) {
  if (!name) { console.error(fmt('error: container name required', C.red)); process.exit(1) }
  const c = store.loadContainer(name)
  if (!c) { console.error(fmt(`error: container '${name}' not found`, C.red)); process.exit(1) }
  if (!fs.existsSync(c.logFile)) { console.log(fmt('  (no logs)', C.dim)); return }
  process.stdout.write(fs.readFileSync(c.logFile))
}

function cmd_stop(name) {
  if (!name) { console.error(fmt('error: container name required', C.red)); process.exit(1) }
  try {
    runtime.stop(name)
    console.log(fmt(`  Container '${name}' stopped`, C.yellow))
  } catch(e) {
    console.error(fmt(`error: ${e.message}`, C.red)); process.exit(1)
  }
}

function cmd_rm(name) {
  if (!name) { console.error(fmt('error: container name required', C.red)); process.exit(1) }
  const c = store.loadContainer(name)
  if (!c) { console.error(fmt(`error: container '${name}' not found`, C.red)); process.exit(1) }
  if (c.status === 'running') { console.error(fmt(`error: container is running. Stop it first.`, C.red)); process.exit(1) }
  store.removeContainer(name)
  console.log(fmt(`  Removed container '${name}'`, C.dim))
}

function cmd_rmi(name) {
  if (!name) { console.error(fmt('error: image name required', C.red)); process.exit(1) }
  images.remove(name)
  console.log(fmt(`  Removed image '${name}'`, C.dim))
}

function cmd_inspect(name) {
  if (!name) { console.error(fmt('error: container name required', C.red)); process.exit(1) }
  const c = store.loadContainer(name)
  if (!c) { console.error(fmt(`error: container '${name}' not found`, C.red)); process.exit(1) }
  console.log(JSON.stringify(c, null, 2))
}

function cmd_build(srcDir, name) {
  if (!srcDir || !name) {
    console.error(fmt('error: Usage: kontainer build <directory> <name>', C.red)); process.exit(1)
  }
  console.log(fmt(`  Building image '${name}' from ${srcDir}...`, C.dim))
  const meta = images.build(srcDir, name)
  console.log(fmt(`  Built image '${name}' (${formatBytes(meta.size)})`, C.green))
}

function cmd_initBase() {
  console.log(fmt('  Creating base image...', C.dim))
  try {
    const meta = images.initBase()
    console.log(fmt(`  ✓ Base image created (${formatBytes(meta.size)})`, C.green))
    console.log(fmt('  Run: node kontainer.js run base sh -c "echo hello"', C.dim))
  } catch(e) {
    console.error(fmt(`  ✗ Failed: ${e.message}`, C.red))
  }
}

function showHelp() {
  console.log(`
${fmt('kontainer', C.bold, C.cyan)} — minimal container runtime

${fmt('Image commands', C.bold)}
  init-base                    Create a base image from host binaries
  build <dir> <name>           Build image from a directory
  images                       List images
  rmi <name>                   Remove an image

${fmt('Container commands', C.bold)}
  run [opts] <image> [cmd...]  Run a container
    --name <name>              Container name (auto-generated if omitted)
    --memory <limit>           Memory limit (e.g. 128m, 1g)
    --cpus <n>                 CPU limit (e.g. 0.5, 2)
    --env KEY=VAL              Set environment variable (repeatable)
    --rm                       Remove container after it exits
  ps [-a]                      List containers (-a for all)
  stop <name>                  Stop a running container
  rm <name>                    Remove a stopped container
  logs <name>                  Print container output
  inspect <name>               Show container details as JSON

${fmt('Isolation', C.dim)}
  Uses Linux user/pid/mount/uts/ipc namespaces via unshare(1).
  Uses cgroup v2 for memory and CPU limits when available.
  No root required — user namespace mapping enabled.
`)
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv

store.ensureDirs()

const commands = {
  'init-base': () => cmd_initBase(),
  'build':     () => cmd_build(args[0], args[1]),
  'images':    () => cmd_images(),
  'rmi':       () => cmd_rmi(args[0]),
  'run':       () => cmd_run(args),
  'ps':        () => cmd_ps(args),
  'stop':      () => cmd_stop(args[0]),
  'rm':        () => cmd_rm(args[0]),
  'logs':      () => cmd_logs(args[0]),
  'inspect':   () => cmd_inspect(args[0]),
  'help':      () => showHelp(),
}

if (!cmd || !commands[cmd]) {
  showHelp()
} else {
  Promise.resolve(commands[cmd]()).catch(e => {
    console.error(fmt(`error: ${e.message}`, C.red))
    process.exit(1)
  })
}
