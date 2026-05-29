'use strict'
const fs            = require('fs')
const path          = require('path')
const crypto        = require('crypto')
const { spawn, execSync, spawnSync } = require('child_process')
const store         = require('./store')
const images        = require('./images')

// ── Cgroup v2 resource limiting ───────────────────────────────────────────────

const CGROUP_ROOT = '/sys/fs/cgroup'

function parseMem(str) {
  if (!str) return null
  const m = str.match(/^(\d+(?:\.\d+)?)(m|g|k)?$/i)
  if (!m) return null
  const n = parseFloat(m[1])
  const u = (m[2] || '').toLowerCase()
  if (u === 'g') return Math.floor(n * 1024 * 1024 * 1024)
  if (u === 'm') return Math.floor(n * 1024 * 1024)
  if (u === 'k') return Math.floor(n * 1024)
  return Math.floor(n)
}

function setupCgroup(name, opts) {
  try {
    const cgPath = path.join(CGROUP_ROOT, `kontainer-${name}`)
    fs.mkdirSync(cgPath, { recursive: true })

    if (opts.memory) {
      const bytes = parseMem(opts.memory)
      if (bytes) fs.writeFileSync(path.join(cgPath, 'memory.max'), String(bytes))
    }

    if (opts.cpus) {
      // cpu.max format: "quota period" e.g. "50000 100000" = 0.5 CPU
      const quota = Math.floor(parseFloat(opts.cpus) * 100000)
      fs.writeFileSync(path.join(cgPath, 'cpu.max'), `${quota} 100000`)
    }

    return cgPath
  } catch(_) {
    return null  // cgroup v2 not available or not writable — continue without limits
  }
}

function assignCgroup(cgPath, pid) {
  try {
    fs.writeFileSync(path.join(cgPath, 'cgroup.procs'), String(pid))
  } catch(_) {}
}

function cleanupCgroup(name) {
  try {
    const cgPath = path.join(CGROUP_ROOT, `kontainer-${name}`)
    if (fs.existsSync(cgPath)) fs.rmdirSync(cgPath)
  } catch(_) {}
}

// ── Namespace isolation ────────────────────────────────────────────────────────

function hasUnshare() {
  return spawnSync('which', ['unshare'], { encoding: 'utf8' }).status === 0
}

function buildUnshareArgs(rootfs, cmd, env) {
  // User namespaces work without root on most modern Linux kernels
  // We need --map-root-user so we appear as root inside the namespace
  const nsFlags = ['--user', '--pid', '--mount', '--uts', '--ipc', '--fork', '--map-root-user']

  // Use nsenter + chroot approach: unshare the namespaces, then chroot
  const innerCmd = [
    'sh', '-c',
    [
      // Mount /proc in the new PID namespace (best-effort)
      `mount -t proc proc "${rootfs}/proc" 2>/dev/null || true`,
      // chroot and exec
      `exec chroot "${rootfs}" ${cmd.map(a => JSON.stringify(a)).join(' ')}`,
    ].join(' && '),
  ]

  return ['unshare', ...nsFlags, ...innerCmd]
}

// ── Run a container ───────────────────────────────────────────────────────────

function run(opts) {
  return new Promise((resolve, reject) => {
    if (!images.exists(opts.image))
      return reject(new Error(`Image not found: ${opts.image}. Run: node kontainer.js images`))

    const name    = opts.name || `c-${crypto.randomBytes(3).toString('hex')}`
    const id      = crypto.randomBytes(8).toString('hex')
    const rootfs  = images.extract(opts.image, name)

    store.ensureLogDir()
    const logFile = store.logPath(name)
    const logFd   = fs.openSync(logFile, 'w')

    const env = { ...process.env, ...(opts.env || {}) }

    // Set container hostname via UTS namespace
    const cmd = opts.cmd && opts.cmd.length ? opts.cmd : ['sh']

    // Try namespace isolation; fall back to plain exec if unshare unavailable
    let spawnArgs, spawnOpts

    if (hasUnshare()) {
      const [prog, ...args] = buildUnshareArgs(rootfs, cmd, env)
      spawnArgs = [prog, args]
    } else {
      // Fallback: no namespace isolation, just chroot
      spawnArgs = ['chroot', [rootfs, ...cmd]]
    }

    spawnOpts = {
      env,
      stdio: ['ignore', logFd, logFd],
      detached: true,
    }

    // Setup cgroup resource limits
    const cgPath = setupCgroup(name, opts)

    const state = {
      id, name,
      image:   opts.image,
      cmd:     cmd.join(' '),
      status:  'running',
      pid:     null,
      created: new Date().toISOString(),
      started: new Date().toISOString(),
      exited:  null,
      exitCode: null,
      logFile,
      config:  { memory: opts.memory || null, cpus: opts.cpus || null, env: opts.env || {} },
    }

    let child
    try {
      child = spawn(spawnArgs[0], spawnArgs[1], spawnOpts)
    } catch(e) {
      fs.closeSync(logFd)
      // Last resort: run cmd directly (no isolation)
      try {
        child = spawn(cmd[0], cmd.slice(1), { env, stdio: ['ignore', logFd, logFd], detached: true, cwd: rootfs })
      } catch(e2) {
        return reject(new Error(`Failed to start container: ${e2.message}`))
      }
    }

    state.pid = child.pid
    store.saveContainer(state)

    if (cgPath) assignCgroup(cgPath, child.pid)

    child.unref()

    child.on('exit', (code, signal) => {
      fs.closeSync(logFd)
      const updated = store.loadContainer(name) || state
      updated.status   = 'exited'
      updated.exitCode = code ?? (signal ? -1 : 0)
      updated.exited   = new Date().toISOString()
      store.saveContainer(updated)
      cleanupCgroup(name)
      if (opts.rm) store.removeContainer(name)
      resolve({ name, exitCode: updated.exitCode })
    })

    child.on('error', (err) => {
      fs.closeSync(logFd)
      state.status   = 'exited'
      state.exitCode = -1
      state.exited   = new Date().toISOString()
      store.saveContainer(state)
      reject(err)
    })
  })
}

function stop(name) {
  const c = store.loadContainer(name)
  if (!c) throw new Error(`Container not found: ${name}`)
  if (c.status !== 'running') throw new Error(`Container '${name}' is not running`)
  try {
    process.kill(c.pid, 'SIGTERM')
    c.status   = 'stopped'
    c.exited   = new Date().toISOString()
    c.exitCode = -15
    store.saveContainer(c)
  } catch(e) {
    throw new Error(`Failed to stop container: ${e.message}`)
  }
}

module.exports = { run, stop }
