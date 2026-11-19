import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { CODEX_REASONING_EFFORTS } from '../protocol/codex-convert.mjs'

const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status })
}
export const QUALITY_EFFORTS = CODEX_REASONING_EFFORTS
export function validateQualityTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length > 200) fail('任务数量不得超过 200')
  const ids = new Set()
  return tasks.map((t) => {
    if (!t || typeof t !== 'object') fail('任务格式错误')
    const out = {}
    for (const [key, max] of Object.entries({
      id: 100,
      name: 160,
      account: 320,
      slot: 100,
      model: 160,
      prompt: 10000,
    })) {
      if (typeof t[key] !== 'string' || !t[key].trim() || t[key].length > max) fail(`任务字段无效：${key}`)
      out[key] = t[key]
    }
    if (ids.has(t.id)) fail('任务 ID 重复')
    ids.add(t.id)
    if (!Number.isSafeInteger(t.interval) || t.interval < 1 || t.interval > 525600)
      fail('检测频率须为 1–525600 的整数分钟')
    if (
      !['candy', 'probe'].includes(t.kind) ||
      !['answer', 'contains'].includes(t.judge) ||
      !['record', 'pause'].includes(t.action) ||
      typeof t.enabled !== 'boolean' ||
      (t.autoRestore != null && typeof t.autoRestore !== 'boolean')
    )
      fail('任务选项无效')
    const autoRestore = t.autoRestore === true
    if (autoRestore && (t.kind !== 'candy' || t.action !== 'pause'))
      fail('自动恢复仅适用于糖果题检测不通过时关闭调度的任务')
    const reasoningEffort = t.reasoningEffort ?? 'medium'
    if (!QUALITY_EFFORTS.includes(reasoningEffort)) fail('思考强度无效')
    return {
      ...out,
      interval: t.interval,
      kind: t.kind,
      judge: t.judge,
      action: t.action,
      autoRestore,
      enabled: t.enabled,
      reasoningEffort,
    }
  })
}

export function qualityTaskRevision(task) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(validateQualityTasks([task])[0]))
    .digest('hex')
}

// Legacy preview switches never become live schedules without an explicit save.
export function qualityConfigStore(projectRoot, owner) {
  if (!owner) fail('缺少配置所属用户', 403)
  const dir = path.join(projectRoot, 'data', 'quality-preview')
  const file = path.join(dir, crypto.createHash('sha256').update(owner).digest('hex') + '.json')
  const read = () => {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'))
      const legacy = value.executionVersion !== 1
      return {
        revision: value.revision,
        requiresActivation: legacy && value.tasks.length > 0,
        tasks: value.tasks.map((task) => ({
          ...task,
          reasoningEffort: task.reasoningEffort ?? 'medium',
          autoRestore: task.autoRestore === true,
          ...(legacy ? { enabled: false, activatedAt: null } : {}),
        })),
      }
    } catch (e) {
      if (e.code === 'ENOENT') return { revision: 0, tasks: [], requiresActivation: false }
      throw e
    }
  }
  return {
    read,
    save(tasks, revision) {
      const clean = validateQualityTasks(tasks)
      const current = read()
      if (revision !== current.revision) fail('配置已被其他页面修改，请刷新后重试', 409)
      const now = new Date().toISOString()
      const next = {
        executionVersion: 1,
        owner,
        revision: current.revision + 1,
        tasks: clean.map((task) => {
          const previous = current.tasks.find((t) => t.id === task.id)
          return { ...task, activatedAt: task.enabled ? (previous?.enabled && previous.activatedAt) || now : null }
        }),
      }
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const tmp = `${file}.${crypto.randomUUID()}.tmp`
      try {
        fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
        fs.renameSync(tmp, file)
      } finally {
        fs.rmSync(tmp, { force: true })
      }
      return read()
    },
  }
}

export function qualityOwners(projectRoot) {
  const dir = path.join(projectRoot, 'data', 'quality-preview')
  if (!fs.existsSync(dir)) return []
  const owners = []
  for (const name of fs.readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (
        value.executionVersion === 1 &&
        typeof value.owner === 'string' &&
        name === crypto.createHash('sha256').update(value.owner).digest('hex') + '.json'
      )
        owners.push(value.owner)
    } catch {
      /* A corrupt configuration must not run. The API reports read errors. */
    }
  }
  return owners
}
