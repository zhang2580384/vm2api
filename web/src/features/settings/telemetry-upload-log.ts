import { z } from 'zod'

/** Safe per-VM native upload counts/status, without payloads or credentials. */
export type UploadEntry = {
  at: number
  events: number
  ok: boolean
  error: string | null
  raw: string
}

export type UploadSummary = {
  entries: UploadEntry[]
  batch: number
  events: number
  failed: number
  first: number | null
  last: number | null
}

const auditSchema = z.object({
  at: z.iso.datetime(),
  ok: z.boolean(),
  events: z.number().int().min(0).max(1000),
  error: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .nullable(),
})

export function parseUploadLine(raw: string): UploadEntry | null {
  try {
    const value = auditSchema.safeParse(JSON.parse(raw))
    if (!value.success) return null
    return {
      at: Date.parse(value.data.at),
      events: value.data.events,
      ok: value.data.ok,
      error: value.data.error,
      raw: JSON.stringify(value.data),
    }
  } catch {
    return null
  }
}

export function summarizeUploads(lines: string[]): UploadSummary {
  const entries = lines
    .map(parseUploadLine)
    .filter((entry): entry is UploadEntry => entry !== null)
    .sort((a, b) => a.at - b.at)
  return {
    entries,
    batch: entries.length,
    events: entries.reduce((total, entry) => total + entry.events, 0),
    failed: entries.filter((e) => !e.ok).length,
    first: entries[0]?.at ?? null,
    last: entries.length ? entries[entries.length - 1].at : null,
  }
}

export function relativeAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s} 秒前`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} 小时前`
  return `${Math.round(h / 24)} 天前`
}
