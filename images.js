'use strict'
const fs            = require('fs')
const path          = require('path')
const { execSync, spawnSync } = require('child_process')
const { IMAGES_DIR, ROOTFS_DIR, ensureDirs } = require('./store')

function imagePath(name) {
  return path.join(IMAGES_DIR, `${name}.tar.gz`)
}

function imageMetaPath(name) {
  return path.join(IMAGES_DIR, `${name}.json`)
}

// Build an image by tarballing a directory
function build(srcDir, name) {
  ensureDirs()
  const abs  = path.resolve(srcDir)
  if (!fs.existsSync(abs)) throw new Error(`Source directory not found: ${abs}`)
  const dest = imagePath(name)
  execSync(`tar -czf "${dest}" -C "${abs}" .`, { stdio: 'pipe' })
  const stat = fs.statSync(dest)
  const meta = { name, created: new Date().toISOString(), size: stat.size, source: abs }
  fs.writeFileSync(imageMetaPath(name), JSON.stringify(meta, null, 2))
  return meta
}

// Extract image to a per-container rootfs dir
function extract(name, containerName) {
  const src  = imagePath(name)
  if (!fs.existsSync(src)) throw new Error(`Image not found: ${name}`)
  const dest = path.join(ROOTFS_DIR, containerName)
  fs.mkdirSync(dest, { recursive: true })
  execSync(`tar -xzf "${src}" -C "${dest}"`, { stdio: 'pipe' })
  return dest
}

function list() {
  ensureDirs()
  return fs.readdirSync(IMAGES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(IMAGES_DIR, f), 'utf8')))
    .sort((a, b) => new Date(b.created) - new Date(a.created))
}

function exists(name) {
  return fs.existsSync(imagePath(name))
}

function remove(name) {
  for (const f of [imagePath(name), imageMetaPath(name)])
    if (fs.existsSync(f)) fs.unlinkSync(f)
}

// Create a minimal base image from the host system's binaries
function initBase() {
  ensureDirs()
  const tmp = path.join(ROOTFS_DIR, '_base_build')
  fs.mkdirSync(tmp, { recursive: true })

  // Create standard directory structure
  for (const d of ['bin', 'lib', 'lib64', 'usr/bin', 'usr/lib', 'tmp', 'proc', 'sys', 'dev', 'etc', 'root', 'home', 'var/log'])
    fs.mkdirSync(path.join(tmp, d), { recursive: true })

  // Write /etc/hostname and /etc/passwd
  fs.writeFileSync(path.join(tmp, 'etc', 'hostname'), 'kontainer\n')
  fs.writeFileSync(path.join(tmp, 'etc', 'passwd'), 'root:x:0:0:root:/root:/bin/sh\n')
  fs.writeFileSync(path.join(tmp, 'etc', 'os-release'), 'NAME="Kontainer Base"\nVERSION="1.0"\n')

  // Copy essential binaries + their shared libraries
  const bins = ['sh', 'bash', 'echo', 'cat', 'ls', 'pwd', 'env', 'sleep', 'true', 'false', 'uname', 'id', 'whoami', 'hostname']
  for (const bin of bins) {
    const result = spawnSync('which', [bin], { encoding: 'utf8' })
    if (result.status !== 0 || !result.stdout.trim()) continue
    const src  = result.stdout.trim()
    const dest = path.join(tmp, 'bin', bin)
    try {
      execSync(`cp "${src}" "${dest}"`, { stdio: 'pipe' })
      // Copy shared libraries using ldd
      const ldd = spawnSync('ldd', [src], { encoding: 'utf8' })
      if (ldd.status === 0) {
        for (const line of ldd.stdout.split('\n')) {
          const m = line.match(/=> (\/[^\s]+)/) || line.match(/^\s+(\/[^\s]+)/)
          if (!m) continue
          const lib = m[1]
          if (!fs.existsSync(lib)) continue
          const libDest = path.join(tmp, lib)
          fs.mkdirSync(path.dirname(libDest), { recursive: true })
          try { if (!fs.existsSync(libDest)) execSync(`cp "${lib}" "${libDest}"`, { stdio: 'pipe' }) } catch(_) {}
        }
      }
    } catch(_) {}
  }
  // Copy the dynamic linker explicitly
  for (const ld of ['/lib64/ld-linux-x86-64.so.2', '/lib/ld-linux-x86-64.so.2', '/lib/ld-musl-x86_64.so.1']) {
    if (fs.existsSync(ld)) {
      const ldDest = path.join(tmp, ld)
      fs.mkdirSync(path.dirname(ldDest), { recursive: true })
      try { if (!fs.existsSync(ldDest)) execSync(`cp "${ld}" "${ldDest}"`, { stdio: 'pipe' }) } catch(_) {}
    }
  }

  const dest = imagePath('base')
  execSync(`tar -czf "${dest}" -C "${tmp}" .`, { stdio: 'pipe' })
  const stat = fs.statSync(dest)
  const meta = { name: 'base', created: new Date().toISOString(), size: stat.size, source: 'init-base' }
  fs.writeFileSync(imageMetaPath('base'), JSON.stringify(meta, null, 2))
  fs.rmSync(tmp, { recursive: true, force: true })
  return meta
}

module.exports = { build, extract, list, exists, remove, initBase, imagePath }
