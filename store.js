'use strict'
const fs   = require('fs')
const path = require('path')
const os   = require('os')

const ROOT        = path.join(os.homedir(), '.kontainer')
const CONTAINERS  = path.join(ROOT, 'containers')
const IMAGES_DIR  = path.join(ROOT, 'images')
const ROOTFS_DIR  = path.join(ROOT, 'rootfs')

function ensureDirs() {
  for (const d of [ROOT, CONTAINERS, IMAGES_DIR, ROOTFS_DIR])
    fs.mkdirSync(d, { recursive: true })
}

// ── Container state ───────────────────────────────────────────────────────────

function containerPath(name) {
  return path.join(CONTAINERS, `${name}.json`)
}

function saveContainer(state) {
  ensureDirs()
  fs.writeFileSync(containerPath(state.name), JSON.stringify(state, null, 2))
}

function loadContainer(name) {
  const p = containerPath(name)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function listContainers() {
  ensureDirs()
  return fs.readdirSync(CONTAINERS)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(CONTAINERS, f), 'utf8')))
    .sort((a, b) => new Date(b.created) - new Date(a.created))
}

function removeContainer(name) {
  const p = containerPath(name)
  if (fs.existsSync(p)) fs.unlinkSync(p)
  const rootfs = path.join(ROOTFS_DIR, name)
  if (fs.existsSync(rootfs)) fs.rmSync(rootfs, { recursive: true, force: true })
}

// ── Log files ─────────────────────────────────────────────────────────────────

function logPath(name) {
  return path.join(ROOT, 'logs', `${name}.log`)
}

function ensureLogDir() {
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true })
}

module.exports = {
  ROOT, CONTAINERS, IMAGES_DIR, ROOTFS_DIR,
  ensureDirs, saveContainer, loadContainer, listContainers, removeContainer,
  logPath, ensureLogDir,
}
