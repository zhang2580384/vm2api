import type { UsageLogRow } from '@/types/panel-usage-logs'
import { Clock, Gauge, Zap } from 'lucide-react'
import {
  calculateOutputRate,
  formatDuration,
  formatTokenAmount,
} from '@/lib/usage-format'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { CircularProgress } from '@/components/ui/circular-progress'
import { latencySegments, queueWaitMs } from '../log-display'
import { LatencyBreakdownBar } from './latency-breakdown-bar'

type Assessment = { label: string; color: string; bg: string }

const ASSESSMENTS: Record<
  'excellent' | 'good' | 'warning' | 'poor',
  Assessment
> = {
  excellent: {
    label: '优秀',
    color: 'text-emerald-600',
    bg: 'bg-emerald-50 dark:bg-emerald-950/20',
  },
  good: {
    label: '良好',
    color: 'text-blue-600',
    bg: 'bg-blue-50 dark:bg-blue-950/20',
  },
  warning: {
    label: '警告',
    color: 'text-amber-600',
    bg: 'bg-amber-50 dark:bg-amber-950/20',
  },
  poor: {
    label: '较差',
    color: 'text-rose-600',
    bg: 'bg-rose-50 dark:bg-rose-950/20',
  },
}

function PerformanceGauge({
  value,
  max,
  icon: Icon,
  label,
  display,
  assessment,
}: {
  value: number
  max: number
  icon: typeof Clock
  label: string
  display: string
  assessment: Assessment
}) {
  return (
    <div
      className={cn(
        'flex flex-1 items-center gap-4 rounded-lg border p-4',
        assessment.bg
      )}
    >
      <div className='relative'>
        <CircularProgress
          value={Math.min(value, max)}
          max={max}
          size={64}
          strokeWidth={5}
          showPercentage={false}
          toneClassName={assessment.color}
        />
        <Icon
          className={cn(
            'absolute top-1/2 left-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2',
            assessment.color
          )}
        />
      </div>
      <div className='min-w-0'>
        <div className='text-xs text-muted-foreground'>{label}</div>
        <div className='font-mono text-xl font-bold'>{display}</div>
        <Badge
          variant='outline'
          className={cn('mt-1 text-[10px]', assessment.color)}
        >
          {assessment.label}
        </Badge>
      </div>
    </div>
  )
}

export function PerformanceTab({ row }: { row: UsageLogRow }) {
  const { ttftMs, durationMs, outputTokens, firstByteMs, generationMs } = row
  const rate = calculateOutputRate(outputTokens, generationMs)
  const wait = row.providerChain[0]?.waitMs ?? null
  const queued = queueWaitMs(row.providerChain)
  const scheduling = row.providerChain[0]?.schedulingMs ?? null
  const breakdown = latencySegments({
    waitMs: wait,
    queueWaitMs: queued,
    schedulingMs: scheduling,
    firstByteMs,
    ttftMs,
    generationMs,
    durationMs,
  })

  if (
    ttftMs == null &&
    durationMs == null &&
    firstByteMs == null &&
    generationMs == null
  ) {
    return (
      <div className='py-8 text-center text-muted-foreground'>
        <Gauge className='mx-auto mb-2 h-8 w-8 opacity-50' />
        暂无性能数据
      </div>
    )
  }

  const ttftAssessment =
    ttftMs == null
      ? null
      : ASSESSMENTS[
          ttftMs < 1000
            ? 'excellent'
            : ttftMs < 2000
              ? 'good'
              : ttftMs < 3000
                ? 'warning'
                : 'poor'
        ]
  const rateAssessment =
    rate == null
      ? null
      : ASSESSMENTS[
          rate >= 80
            ? 'excellent'
            : rate >= 50
              ? 'good'
              : rate >= 30
                ? 'warning'
                : 'poor'
        ]

  const finalizationMs =
    breakdown?.find((s) => s.key === 'finalization')?.ms ?? 0

  const rows: [string, string][] = []
  if (scheduling != null) rows.push(['调度处理', formatDuration(scheduling)])
  if (queued != null) rows.push(['排队等待', formatDuration(queued)])
  if (scheduling == null && wait != null)
    rows.push(['调度与排队（未拆分）', formatDuration(wait)])
  if (firstByteMs != null)
    rows.push(['首字节时间（TTFB）', formatDuration(firstByteMs)])
  if (ttftMs != null)
    rows.push(['首 Token 时间（TTFT）', formatDuration(ttftMs)])
  if (generationMs != null && generationMs > 0)
    rows.push(['上游输出时间（含推理）', formatDuration(generationMs)])
  if (finalizationMs > 0) rows.push(['收尾', formatDuration(finalizationMs)])
  if (durationMs != null) rows.push(['总耗时', formatDuration(durationMs)])
  rows.push(['输出 Tokens', formatTokenAmount(outputTokens)])
  if (rate != null) rows.push(['输出速率', `${rate.toFixed(1)} tok/s`])

  return (
    <div className='space-y-6'>
      {ttftAssessment || rateAssessment ? (
        <div className='flex flex-col gap-4 sm:flex-row'>
          {ttftAssessment && ttftMs != null ? (
            <PerformanceGauge
              value={ttftMs}
              max={3000}
              icon={Clock}
              label='首 Token 时间'
              display={formatDuration(ttftMs)}
              assessment={ttftAssessment}
            />
          ) : null}
          {rateAssessment && rate != null ? (
            <PerformanceGauge
              value={rate}
              max={100}
              icon={Zap}
              label='输出速率'
              display={`${rate.toFixed(1)} tok/s`}
              assessment={rateAssessment}
            />
          ) : null}
        </div>
      ) : null}
      {breakdown ? (
        <div className='space-y-2'>
          <h4 className='flex items-center gap-2 text-sm font-semibold'>
            <Gauge className='h-4 w-4 text-purple-600' />
            延迟分解
          </h4>
          <div className='rounded-lg border bg-card p-4'>
            <LatencyBreakdownBar
              waitMs={wait}
              queueWaitMs={queued}
              schedulingMs={scheduling}
              firstByteMs={firstByteMs}
              ttftMs={ttftMs}
              generationMs={generationMs}
              durationMs={durationMs}
            />
          </div>
        </div>
      ) : null}
      <div className='space-y-2'>
        <h4 className='text-sm font-semibold'>性能数据</h4>
        <div className='divide-y rounded-lg border bg-card'>
          {rows.map(([label, value]) => (
            <div
              key={label}
              className='flex items-center justify-between px-4 py-3'
            >
              <span className='text-sm text-muted-foreground'>{label}</span>
              <span className='font-mono text-sm font-medium'>{value}</span>
            </div>
          ))}
        </div>
        {generationMs != null && generationMs > 0 ? (
          <p className='text-xs text-muted-foreground'>
            上游输出窗口从首个协议事件计到终止生成事件，含不可见推理；速率用该窗口，不含收尾。
          </p>
        ) : null}
      </div>
    </div>
  )
}
