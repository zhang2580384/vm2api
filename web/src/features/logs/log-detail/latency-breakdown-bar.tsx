import { formatDuration } from '@/lib/usage-format'
import { cn } from '@/lib/utils'
import { latencySegments, segmentWidth } from '../log-display'

/**
 * 延迟分解条：排队 → 上游响应等待 → 首 Token 等待 → 内容输出 → 收尾。
 * 生成段来自实测 generationMs，不把收尾算进生成。
 */
export function LatencyBreakdownBar({
  waitMs,
  queueWaitMs,
  schedulingMs,
  firstByteMs,
  ttftMs,
  generationMs,
  durationMs,
}: {
  waitMs: number | null
  queueWaitMs: number | null
  schedulingMs: number | null
  firstByteMs: number | null
  ttftMs: number | null
  generationMs: number | null
  durationMs: number | null
}) {
  const segments = latencySegments({
    waitMs,
    queueWaitMs,
    schedulingMs,
    firstByteMs,
    ttftMs,
    generationMs,
    durationMs,
  })
  if (!segments || durationMs == null) return null
  const visible = segments.filter((s) => s.ms > 0)
  return (
    <div className='space-y-2'>
      <div className='flex h-6 w-full overflow-hidden rounded-lg bg-muted/50'>
        {visible.map((s) => (
          <div
            key={s.key}
            className={cn(
              'flex items-center justify-center text-[10px] font-medium text-white transition-all duration-200',
              s.color
            )}
            style={{ width: `${segmentWidth(s)}%` }}
            title={`${s.label}: ${formatDuration(s.ms)} (${s.percent.toFixed(1)}%)`}
          >
            {s.percent >= 15 ? (
              <span className='truncate px-1'>{s.label}</span>
            ) : null}
          </div>
        ))}
      </div>
      <div className='flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs'>
        {visible.map((s) => (
          <div key={s.key} className='flex items-center gap-1.5'>
            <div className={cn('h-2.5 w-2.5 rounded-sm', s.color)} />
            <span className='text-muted-foreground'>{s.label}:</span>
            <span className='font-mono font-medium'>
              {formatDuration(s.ms)}
            </span>
          </div>
        ))}
      </div>
      <div className='text-center text-xs text-muted-foreground'>
        总计: {formatDuration(durationMs)}
      </div>
    </div>
  )
}
