import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  FileText,
  FlaskConical,
  Layers,
  ListChecks,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Radar,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import type { PoolCredential } from '@/features/credentials'
import {
  vmsListQueryOptions,
  testModelsQueryOptions,
} from '@/features/vm/queries'
import {
  CANDY_PROMPT,
  formatRecordDate,
  formatRecordTime,
  type QualityRecord,
  type QualityTask,
} from './quality-preview'

const selectClass =
  'h-9 rounded-md border bg-background px-2.5 text-xs outline-none focus:ring-2 focus:ring-ring'
const resultLabels = {
  running: '检测中',
  passed: '通过',
  failed: '检测不通过',
  error: '无法判断',
  skipped: '已跳过',
}
function ResultBadge({ result }: { result: QualityRecord['result'] }) {
  const Icon =
    result === 'running'
      ? Loader2
      : result === 'skipped'
        ? Clock3
        : result === 'passed'
          ? CheckCircle2
          : result === 'failed'
            ? XCircle
            : TriangleAlert
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium',
        result === 'passed'
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
          : result === 'failed'
            ? 'bg-rose-500/10 text-rose-700 dark:text-rose-400'
            : result === 'running'
              ? 'bg-blue-500/10 text-blue-700 dark:text-blue-400'
              : result === 'skipped'
                ? 'bg-muted text-muted-foreground'
                : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
      )}
    >
      <Icon
        className={cn('size-3.5', result === 'running' && 'animate-spin')}
      />
      {resultLabels[result]}
    </span>
  )
}
function KindIcon({
  kind,
  className,
}: {
  kind: QualityTask['kind']
  className?: string
}) {
  const Icon = kind === 'candy' ? FlaskConical : Radar
  return <Icon className={className || 'size-4'} />
}

// randomUUID requires HTTPS; getRandomValues also works on a LAN HTTP panel.
function previewId() {
  return `preview-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`
}

export function QualityWorkspace() {
  const qc = useQueryClient()
  const config = useQuery({
    queryKey: ['quality-preview'],
    queryFn: () =>
      api<{
        tasks: QualityTask[]
        revision: number
        requiresActivation: boolean
        runtime: { manual: boolean; scheduled: boolean; probe: boolean }
      }>('/api/panel/quality-preview'),
  })
  const tasks = config.data?.tasks || []
  const [saving, setSaving] = useState(false)
  const saveLock = useRef(false)
  async function persist(next: QualityTask[]) {
    if (!config.data || saveLock.current) return false
    saveLock.current = true
    setSaving(true)
    try {
      const result = await api<NonNullable<typeof config.data>>(
        '/api/panel/quality-preview',
        {
          method: 'PUT',
          body: JSON.stringify({ tasks: next, revision: config.data.revision }),
        }
      )
      qc.setQueryData(['quality-preview'], result)
      toast.success('检测配置已保存')
      return true
    } catch (e) {
      toast.error((e as Error).message)
      return false
    } finally {
      saveLock.current = false
      setSaving(false)
    }
  }
  const history = useQuery({
    queryKey: ['quality-records'],
    queryFn: () =>
      api<{ items: QualityRecord[] }>('/api/panel/quality-preview/records'),
    enabled: config.data?.runtime?.manual === true,
    refetchInterval: (query) =>
      query.state.data?.items.some((record) => record.result === 'running')
        ? 2000
        : 10000,
  })
  const records = history.data?.items || []
  const [selected, setSelected] = useState('all')
  const [checked, setChecked] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [recordQuery, setRecordQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [visibleCount, setVisibleCount] = useState(8)
  const [editor, setEditor] = useState<QualityTask | null>(null)
  const [selectedDetail, setDetail] = useState<QualityRecord | null>(null)
  const detail =
    records.find((record) => record.id === selectedDetail?.id) || selectedDetail
  const [deleteIds, setDeleteIds] = useState<string[]>([])
  const [starting, setStarting] = useState<string | null>(null)
  const active = tasks.find((task) => task.id === selected)
  const visibleTasks = tasks.filter((task) =>
    `${task.name} ${task.account} ${task.model} ${task.slot}`
      .toLowerCase()
      .includes(query.toLowerCase())
  )
  const filtered = records.filter(
    (record) =>
      (selected === 'all' || record.taskId === selected) &&
      (filter === 'all' || record.result === filter) &&
      `${record.account} ${record.model} ${record.taskName}`
        .toLowerCase()
        .includes(recordQuery.toLowerCase())
  )
  const allChecked =
    visibleTasks.length > 0 &&
    visibleTasks.every((task) => checked.includes(task.id))
  function toggle(id: string) {
    setChecked((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    )
  }
  function setTaskEnabled(ids: string[], enabled: boolean) {
    void persist(
      tasks.map((task) => (ids.includes(task.id) ? { ...task, enabled } : task))
    )
  }
  function newTask() {
    setEditor({
      id: previewId(),
      name: '',
      account: '',
      slot: '',
      model: '',
      prompt: CANDY_PROMPT,
      kind: 'candy',
      judge: 'contains',
      interval: 30,
      enabled: true,
      action: 'record',
      autoRestore: false,
      reasoningEffort: 'medium',
    })
  }
  async function runOnce(task: QualityTask) {
    if (starting || !config.data) return
    setStarting(task.id)
    try {
      const result = await api<{ record: QualityRecord }>(
        `/api/panel/quality-preview/${encodeURIComponent(task.id)}/run`,
        {
          method: 'POST',
          body: JSON.stringify({ revision: config.data.revision }),
        }
      )
      qc.setQueryData<{ items: QualityRecord[] }>(
        ['quality-records'],
        (current) => ({ items: [result.record, ...(current?.items || [])] })
      )
      setSelected(task.id)
      setFilter('all')
      setRecordQuery('')
      setDetail(result.record)
      await qc.invalidateQueries({ queryKey: ['quality-records'] })
      toast.success('真实检测已启动，结果将自动更新')
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setStarting(null)
    }
  }
  return (
    <>
      {config.isError && (
        <p role='alert' className='mb-3 text-sm text-destructive'>
          配置读取失败：{config.error.message}{' '}
          <button onClick={() => void config.refetch()}>重试</button>
        </p>
      )}
      {config.isPending && (
        <p className='mb-3 text-sm'>正在读取已保存的任务…</p>
      )}
      {config.data?.requiresActivation && (
        <p className='mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300'>
          旧预览任务已保留。请重新启用需要执行的任务，才会开始真实定时检测。
        </p>
      )}
      {history.isError && (
        <p role='alert' className='mb-3 text-sm text-destructive'>
          检测记录读取失败：{history.error.message}
        </p>
      )}
      <div className='grid min-w-0 gap-4 lg:h-[calc(100dvh-245px)] lg:min-h-[520px] lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[350px_minmax(0,1fr)]'>
        <aside
          aria-label='质量检测任务列表'
          className='flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm'
        >
          <div className='space-y-4 border-b p-4'>
            <div className='flex items-center justify-between gap-2'>
              <div className='flex items-center gap-2'>
                <ListChecks className='size-4 text-muted-foreground' />
                <h2 className='font-semibold'>检测任务</h2>
                <span className='rounded bg-muted px-1.5 text-xs text-muted-foreground'>
                  {tasks.length}
                </span>
              </div>
              <Button
                size='sm'
                disabled={!config.data || saving}
                onClick={newTask}
              >
                <Plus className='size-3.5' />
                新建任务
              </Button>
            </div>
            <div className='relative'>
              <Search className='absolute top-2.5 left-3 size-4 text-muted-foreground' />
              <Input
                aria-label='搜索检测任务'
                className='h-9 pl-9 text-xs'
                placeholder='搜索任务、账号或模型'
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className='flex items-center justify-between gap-2 text-xs'>
              <label className='flex cursor-pointer items-center gap-2 text-muted-foreground'>
                <input
                  type='checkbox'
                  className='size-3.5 accent-emerald-500'
                  aria-label='选择全部筛选任务'
                  checked={allChecked}
                  onChange={() =>
                    setChecked(
                      allChecked
                        ? checked.filter(
                            (id) => !visibleTasks.some((task) => task.id === id)
                          )
                        : [
                            ...new Set([
                              ...checked,
                              ...visibleTasks.map((task) => task.id),
                            ]),
                          ]
                    )
                  }
                />
                {checked.length ? `已选 ${checked.length} 项` : '选择任务'}
              </label>
              <div className='flex gap-3'>
                <button
                  className='text-muted-foreground hover:text-foreground disabled:opacity-35'
                  disabled={!checked.length}
                  onClick={() => setTaskEnabled(checked, false)}
                >
                  批量暂停
                </button>
                <button
                  aria-label='批量删除任务'
                  className='text-destructive disabled:opacity-35'
                  disabled={!checked.length}
                  onClick={() => setDeleteIds(checked)}
                >
                  删除
                </button>
              </div>
            </div>
          </div>
          <div className='min-h-0 flex-1 space-y-2 overflow-y-auto p-3 lg:overscroll-contain'>
            <button
              onClick={() => {
                setSelected('all')
                setVisibleCount(8)
              }}
              className={cn(
                'mb-1 flex w-full items-center justify-between rounded-lg px-3 py-3 text-sm transition-colors',
                selected === 'all'
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-muted-foreground hover:bg-muted'
              )}
            >
              <span className='flex items-center gap-2'>
                <Layers className='size-4' />
                全部检测任务
              </span>
              <span className='font-mono text-xs'>{tasks.length}</span>
            </button>
            {visibleTasks.map((task) => (
              <article
                key={task.id}
                className={cn(
                  'rounded-lg border bg-background/40 transition-colors',
                  selected === task.id
                    ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/10'
                    : 'hover:border-muted-foreground/40'
                )}
              >
                <div className='flex items-start gap-2.5 px-3 pt-3'>
                  <input
                    type='checkbox'
                    checked={checked.includes(task.id)}
                    aria-label={`选择 ${task.name}`}
                    onChange={() => toggle(task.id)}
                    className='mt-2 size-3.5 shrink-0 accent-emerald-500'
                  />
                  <button
                    className='min-w-0 flex-1 text-left'
                    onClick={() => {
                      setSelected(task.id)
                      setVisibleCount(8)
                    }}
                    aria-pressed={selected === task.id}
                  >
                    <div className='flex items-center justify-between gap-2'>
                      <span className='truncate text-sm font-medium'>
                        {task.name}
                      </span>
                      <span
                        className={cn(
                          'flex shrink-0 items-center gap-1 text-[10px]',
                          task.enabled
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-muted-foreground'
                        )}
                      >
                        <span
                          className={cn(
                            'size-1.5 rounded-full',
                            task.enabled
                              ? 'bg-emerald-500'
                              : 'bg-muted-foreground/50'
                          )}
                        />
                        {task.enabled ? '已启用' : '已暂停'}
                      </span>
                    </div>
                    <p className='mt-1 truncate text-[11px] text-muted-foreground'>
                      {task.account}
                    </p>
                    <div className='mt-3 flex items-center gap-2'>
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]',
                          task.kind === 'candy'
                            ? 'bg-violet-500/10 text-violet-600 dark:text-violet-300'
                            : 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
                        )}
                      >
                        <KindIcon kind={task.kind} className='size-3' />
                        {task.kind === 'candy' ? '糖果题' : '探针'}
                      </span>
                      <code className='truncate text-[10px] text-muted-foreground'>
                        {task.model}
                      </code>
                    </div>
                    <div className='mt-3 flex items-center justify-between gap-2 text-[10px] text-muted-foreground'>
                      <span className='flex items-center gap-1'>
                        <Clock3 className='size-3' />每 {task.interval} 分钟
                      </span>
                      <span>
                        {task.action === 'record'
                          ? '不通过仅记录'
                          : task.autoRestore
                            ? '不通过关闭 · 通过恢复'
                            : '不通过关闭调度'}
                      </span>
                    </div>
                  </button>
                </div>
                <div className='mx-3 mt-3 flex items-center justify-between gap-1 border-t py-2'>
                  <button
                    className='flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary'
                    onClick={() => {
                      setSelected(task.id)
                      setVisibleCount(8)
                    }}
                  >
                    <FileText className='size-3' />
                    记录
                  </button>
                  <button
                    aria-label={`编辑 ${task.name}`}
                    className='flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground'
                    onClick={() => setEditor({ ...task })}
                  >
                    <Pencil className='size-3' />
                    编辑
                  </button>
                  <button
                    aria-label={`${task.enabled ? '暂停' : '启用'} ${task.name}`}
                    className='text-muted-foreground hover:text-foreground'
                    onClick={() => setTaskEnabled([task.id], !task.enabled)}
                  >
                    {task.enabled ? (
                      <Pause className='size-3' />
                    ) : (
                      <Play className='size-3' />
                    )}
                  </button>
                  <button
                    className='flex items-center gap-1 text-[11px] text-primary'
                    disabled={
                      !!starting ||
                      saving ||
                      !config.data?.runtime?.manual ||
                      records.some(
                        (record) =>
                          record.account === task.account &&
                          record.result === 'running'
                      )
                    }
                    onClick={() => void runOnce(task)}
                  >
                    <Play className='size-3' />
                    {starting === task.id ||
                    records.some(
                      (record) =>
                        record.account === task.account &&
                        record.result === 'running'
                    )
                      ? '检测中…'
                      : '立即检测一次'}
                  </button>
                </div>
              </article>
            ))}
            {!visibleTasks.length && (
              <div className='px-4 py-12 text-center text-sm text-muted-foreground'>
                <Search className='mx-auto mb-3 size-6 opacity-40' />
                {tasks.length
                  ? '没有匹配的检测任务'
                  : '还没有任务，点击新建开始检测'}
              </div>
            )}
          </div>
          <div className='flex items-center gap-1.5 border-t px-4 py-3 text-[10px] text-muted-foreground'>
            <ShieldCheck className='size-3.5' />
            {saving
              ? '正在保存…'
              : config.data?.runtime.manual
                ? '真实检测已接入 · 记录保存到服务器'
                : '检测服务未启动'}
          </div>
        </aside>

        <section
          aria-label='质量检测任务记录'
          className='flex min-h-[440px] min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm lg:min-h-0'
        >
          <div className='flex items-center justify-between border-b px-5 py-4'>
            <div>
              <h2 className='font-semibold'>任务记录</h2>
              <p className='mt-1 text-xs text-muted-foreground'>
                检测结果与账号处理，分别查看。
              </p>
            </div>
            <span className='rounded-full bg-muted px-2.5 py-1 font-mono text-[11px] text-muted-foreground'>
              {filtered.length} 条记录
            </span>
          </div>
          <div className='flex flex-wrap items-center justify-between gap-3 border-b bg-muted/20 px-5 py-3'>
            <span className='flex min-w-0 items-center gap-2 text-xs font-medium'>
              <span className='size-1.5 rounded-full bg-primary' />
              <span className='truncate'>{active?.name || '全部检测任务'}</span>
            </span>
            <div className='flex max-w-full gap-2'>
              <div className='relative min-w-0'>
                <Search className='absolute top-2.5 left-2.5 size-3.5 text-muted-foreground' />
                <Input
                  aria-label='搜索检测记录'
                  className='h-8 w-40 pl-8 text-xs'
                  placeholder='搜索记录'
                  value={recordQuery}
                  onChange={(event) => {
                    setRecordQuery(event.target.value)
                    setVisibleCount(8)
                  }}
                />
              </div>
              <select
                aria-label='筛选检测结果'
                className={cn(selectClass, 'h-8')}
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value)
                  setVisibleCount(8)
                }}
              >
                <option value='all'>全部结果</option>
                <option value='passed'>检测通过</option>
                <option value='failed'>检测不通过</option>
                <option value='error'>无法判断</option>
                <option value='running'>检测中</option>
                <option value='skipped'>已跳过</option>
              </select>
            </div>
          </div>
          <div className='min-h-0 flex-1 overflow-auto lg:overscroll-contain'>
            <table className='w-full min-w-[650px] text-left text-xs'>
              <thead className='sticky top-0 z-10 bg-card text-[11px] text-muted-foreground'>
                <tr className='border-b'>
                  <th className='px-5 py-3 font-normal'>检测时间</th>
                  <th className='px-3 py-3 font-normal'>检测账号 / 模型</th>
                  <th className='px-3 py-3 font-normal'>检测结果</th>
                  <th className='px-3 py-3 font-normal'>账号处理</th>
                  <th className='w-16 px-4 py-3'>
                    <span className='sr-only'>详情</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, visibleCount).map((record) => (
                  <tr
                    key={record.id}
                    className='group border-b border-border/60 transition-colors hover:bg-muted/30'
                  >
                    <td className='px-5 py-4.5 align-top'>
                      <p className='font-mono font-medium tabular-nums'>
                        {formatRecordTime(record.time)}
                      </p>
                      <p className='mt-1.5 text-[10px] text-muted-foreground'>
                        {formatRecordDate(record.time)}
                      </p>
                    </td>
                    <td className='max-w-56 px-3 py-4.5 align-top'>
                      <p className='truncate font-medium'>{record.account}</p>
                      <p className='mt-1.5 truncate font-mono text-[10px] text-muted-foreground'>
                        {record.model}
                      </p>
                      <p className='mt-1 text-[10px] text-muted-foreground'>
                        {record.slot}
                      </p>
                    </td>
                    <td className='px-3 py-4.5 align-top'>
                      <ResultBadge result={record.result} />
                      <p className='mt-1.5 text-[10px] text-muted-foreground'>
                        {record.kind === 'candy'
                          ? record.judge === 'answer'
                            ? '最终答案 = 21'
                            : '包含独立数字 21'
                          : '两次门票探针'}{' '}
                        · {record.latency}
                      </p>
                    </td>
                    <td className='px-3 py-4.5 align-top'>
                      <p
                        className={cn(
                          'mt-1 text-[11px]',
                          record.action === '已关闭槽位调度'
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-muted-foreground'
                        )}
                      >
                        {record.action}
                      </p>
                      <p className='mt-2 text-[10px] text-muted-foreground/65'>
                        {record.source === 'scheduled'
                          ? '定时检测'
                          : '手动检测'}
                      </p>
                    </td>
                    <td className='px-3 py-4.5 align-top'>
                      <button
                        aria-label={`查看记录 ${record.id}`}
                        className='mt-1 flex items-center gap-1 text-[11px] whitespace-nowrap text-muted-foreground hover:text-primary'
                        onClick={() => setDetail(record)}
                      >
                        详情
                        <ArrowRight className='size-3.5 transition-transform group-hover:translate-x-0.5' />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filtered.length && (
              <div className='flex flex-col items-center justify-center gap-2 py-20 text-muted-foreground'>
                <FileText className='mb-2 size-8 opacity-30' />
                <p className='text-sm'>暂无匹配记录</p>
                <p className='text-xs'>
                  点击任务中的“立即检测一次”，查看真实结果。
                </p>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() => {
                    setFilter('all')
                    setRecordQuery('')
                  }}
                >
                  清除筛选
                </Button>
              </div>
            )}
          </div>
          <div className='flex items-center justify-between gap-2 border-t px-5 py-3 text-[11px] text-muted-foreground'>
            <span>
              显示 {Math.min(visibleCount, filtered.length)} / {filtered.length}{' '}
              条记录<span className='ml-2 hidden xl:inline'>· 北京时间</span>
            </span>
            <button
              className='flex items-center gap-1 text-primary disabled:text-muted-foreground/40'
              disabled={visibleCount >= filtered.length}
              onClick={() => setVisibleCount((count) => count + 8)}
            >
              {visibleCount >= filtered.length ? '已加载全部' : '加载更多'}
              <ArrowDown className='size-3' />
            </button>
          </div>
        </section>
      </div>

      <TaskEditor
        key={editor?.id || 'closed'}
        task={editor}
        existing={tasks.some((task) => task.id === editor?.id)}
        onClose={() => setEditor(null)}
        saving={saving}
        onSave={async (task) => {
          const next = tasks.some((item) => item.id === task.id)
            ? tasks.map((item) => (item.id === task.id ? task : item))
            : [task, ...tasks]
          if (await persist(next)) {
            setSelected(task.id)
            setEditor(null)
          }
        }}
      />
      <Sheet
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetail(null)
        }}
      >
        <SheetContent className='w-full overflow-y-auto sm:max-w-xl'>
          <SheetHeader className='border-b px-6 pt-6 pb-5'>
            <span className='mb-2 text-[10px] font-medium tracking-widest text-primary'>
              QUALITY / RECORD
            </span>
            <SheetTitle>检测记录详情</SheetTitle>
            <SheetDescription>
              真实模型请求结果，完整回答与处理结果均保存到服务器。
            </SheetDescription>
          </SheetHeader>
          {detail && (
            <div className='space-y-6 px-6 pb-6'>
              <div className='flex items-center justify-between'>
                <ResultBadge result={detail.result} />
                <span className='text-xs text-muted-foreground'>
                  {formatRecordDate(detail.time)}{' '}
                  {formatRecordTime(detail.time)}
                </span>
              </div>
              <dl className='grid grid-cols-2 gap-4 rounded-lg border bg-muted/20 p-4 text-xs'>
                {[
                  ['检测任务', detail.taskName],
                  ['检测账号', detail.account],
                  ['模型', detail.model],
                  ['响应耗时', detail.latency],
                  ['思考强度', detail.reasoningEffort || '模型默认'],
                  [
                    '执行方式',
                    detail.source === 'scheduled' ? '定时检测' : '立即检测',
                  ],
                ].map(([name, value]) => (
                  <div key={name}>
                    <dt className='text-muted-foreground'>{name}</dt>
                    <dd className='mt-1.5 font-medium break-all'>{value}</dd>
                  </div>
                ))}
              </dl>
              {detail.probe && (
                <dl className='grid grid-cols-2 gap-4 rounded-lg border p-4 text-xs'>
                  {[
                    [
                      '打票 / 续接 HTTP',
                      `${detail.probe.mint_status || '未请求'} / ${detail.probe.continue_status || '未请求'}`,
                    ],
                    [
                      '门票长度 / 续接长度',
                      `${detail.probe.ticket_length} / ${detail.probe.continue_ticket_length}`,
                    ],
                    [
                      '续接是否返回不同新票',
                      detail.probe.new_ticket ? '是' : '否',
                    ],
                    [
                      '上报模型（仅展示）',
                      detail.probe.reported_model || '未返回',
                    ],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className='text-muted-foreground'>{label}</dt>
                      <dd className='mt-1.5 break-all'>{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <section>
                <h3 className='mb-2 flex items-center gap-2 text-sm font-medium'>
                  <KindIcon kind={detail.kind} />
                  {detail.kind === 'candy'
                    ? '糖果题 · 固定答案判定'
                    : '门票探针'}
                </h3>
                <p className='text-xs leading-relaxed text-muted-foreground'>
                  {detail.kind === 'candy'
                    ? detail.judge === 'answer'
                      ? '最终答案为 21；允许常见标点、答案前缀和糖果单位，无需裁判模型。'
                      : '包含独立数字 21 即通过，无需裁判模型；下方展示完整回答供人工复核。'
                    : '采用 sub2 两次完整请求与路由 Cookie 比较门票。新票视为疑似降级；网络、授权或不完整流均无法判断，不作为通过。该经验判据不代表服务方质量保证。'}
                </p>
              </section>
              <section>
                <h3 className='mb-2 text-xs font-medium'>检测题目</h3>
                <pre className='overflow-x-auto rounded-lg border bg-muted/30 p-4 font-mono text-xs leading-6 whitespace-pre-wrap'>
                  {detail.kind === 'candy'
                    ? detail.prompt
                    : '两次完整请求均为 Reply with OK.；每次使用新的会话，续接仅携带第一发门票与两枚路由 Cookie。'}
                </pre>
              </section>
              <section>
                <h3 className='mb-2 text-xs font-medium'>完整回答</h3>
                {detail.outputTruncated && (
                  <p className='mb-2 text-xs text-amber-600'>
                    回答超过保存上限，当前展示前 262144
                    个字符；判定使用截断前的完整回答。
                  </p>
                )}
                <pre className='rounded-lg border border-primary/15 bg-primary/5 p-4 font-mono text-sm break-words whitespace-pre-wrap'>
                  {detail.output ||
                    (detail.result === 'running'
                      ? '正在真实请求模型，请稍候…'
                      : '（空响应）')}
                </pre>
              </section>
              <section className='rounded-lg border p-4'>
                <h3 className='flex items-center gap-2 text-sm font-medium'>
                  <ShieldCheck className='size-4 text-muted-foreground' />
                  账号处理
                </h3>
                <p className='mt-2 text-xs'>{detail.action}</p>
                <p className='mt-1.5 text-xs text-muted-foreground'>
                  请求异常或无法判断只记录，不关闭调度；仅确定不通过时按任务配置处理。暂停任务仍可手动检测，但不自动关闭调度。
                </p>
              </section>
            </div>
          )}
        </SheetContent>
      </Sheet>
      <Sheet
        open={!!deleteIds.length}
        onOpenChange={(open) => {
          if (!open) setDeleteIds([])
        }}
      >
        <SheetContent className='w-full sm:max-w-md'>
          <SheetHeader className='px-6 py-6'>
            <SheetTitle>删除 {deleteIds.length} 个检测任务？</SheetTitle>
            <SheetDescription>
              删除会保存到服务器，刷新后不会恢复；已有真实检测记录仍保留。
            </SheetDescription>
          </SheetHeader>
          <SheetFooter className='px-6'>
            <Button
              variant='destructive'
              disabled={saving}
              onClick={async () => {
                if (
                  !(await persist(
                    tasks.filter((task) => !deleteIds.includes(task.id))
                  ))
                )
                  return
                setChecked((current) =>
                  current.filter((id) => !deleteIds.includes(id))
                )
                if (deleteIds.includes(selected)) setSelected('all')
                setDeleteIds([])
              }}
            >
              <Trash2 className='size-4' />
              删除检测任务
            </Button>
            <Button variant='outline' onClick={() => setDeleteIds([])}>
              取消
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  )
}

function TaskEditor({
  task,
  existing,
  saving,
  onClose,
  onSave,
}: {
  task: QualityTask | null
  existing: boolean
  saving: boolean
  onClose: () => void
  onSave: (task: QualityTask) => Promise<void>
}) {
  const [draft, setDraft] = useState(task)
  const [error, setError] = useState('')
  const vmQuery = useQuery({ ...vmsListQueryOptions(), enabled: !!task })
  const pool = useQuery({
    queryKey: ['login-credentials'],
    queryFn: () =>
      api<{ credentials: PoolCredential[] }>('/api/panel/login-credentials'),
    enabled: !!task,
  })
  const targets = (vmQuery.data?.items || []).map((vm) => {
    const bound = pool.data?.credentials.find((c) =>
      c.bound_vm_ids.includes(vm.id)
    )
    const account = bound?.email || vm.email || ''
    return {
      id: vm.id,
      account,
      label: `${account || '未绑定账号'} · ${vm.name || vm.id}${vm.name && vm.name !== vm.id ? ` (${vm.id})` : ''}`,
    }
  })
  const models = useQuery(testModelsQueryOptions(draft?.slot || ''))
  const modelItems = models.data?.items || models.data?.models || []
  const target = targets.find(
    (t) => t.id === draft?.slot && t.account === draft?.account
  )
  function update(patch: Partial<QualityTask>) {
    setDraft((current) => (current ? { ...current, ...patch } : current))
  }
  function save() {
    if (!draft) return
    if (draft.kind === 'probe' && !/^(gpt-|codex)/i.test(draft.model)) {
      setError('门票探针仅支持 GPT OAuth 槽位，请选择 GPT 模型或使用糖果题检测')
      return
    }
    if (
      !draft.name.trim() ||
      !target?.account ||
      !modelItems.some((m) => m.id === draft.model)
    ) {
      setError('请填写任务名称，并选择有效的账号 + 槽位及受支持模型')
      return
    }
    if (
      !Number.isSafeInteger(draft.interval) ||
      draft.interval < 1 ||
      draft.interval > 525600
    ) {
      setError('检测频率须为 1–525600 的整数分钟')
      return
    }
    if (!draft.prompt.trim()) {
      setError('糖果题目不能为空')
      return
    }
    void onSave({
      ...draft,
      name: draft.name.trim(),
      account: draft.account.trim(),
      model: draft.model.trim(),
    })
  }
  return (
    <Sheet
      open={!!task}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent className='w-full sm:max-w-xl'>
        <SheetHeader className='border-b px-6 pt-6 pb-5'>
          <span className='mb-2 text-[10px] font-medium tracking-widest text-primary'>
            QUALITY / TASK
          </span>
          <SheetTitle>{existing ? '编辑检测任务' : '新建检测任务'}</SheetTitle>
          <SheetDescription>
            配置持久保存。启用后按分钟定时执行，也可立即检测一次；真实请求会消耗少量额度。
          </SheetDescription>
        </SheetHeader>
        {draft && (
          <form
            id='quality-task-form'
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
            className='min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-3'
          >
            <section className='space-y-4'>
              <h3 className='flex items-center gap-2 text-xs font-semibold'>
                <span className='flex size-5 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground'>
                  01
                </span>
                检测对象
              </h3>
              <label className='block space-y-2 text-xs'>
                任务名称
                <Input
                  value={draft.name}
                  onChange={(event) => update({ name: event.target.value })}
                  placeholder='例如：GPT 推理质量巡检'
                />
              </label>
              <label className='block space-y-2 text-xs'>
                账号 + 槽位
                <select
                  aria-label='账号 + 槽位'
                  className={cn(selectClass, 'w-full')}
                  value={target ? draft.slot : ''}
                  disabled={
                    vmQuery.isPending ||
                    pool.isPending ||
                    vmQuery.isError ||
                    pool.isError
                  }
                  onChange={(e) => {
                    const t = targets.find((t) => t.id === e.target.value)
                    update({
                      slot: t?.id || '',
                      account: t?.account || '',
                      model: '',
                    })
                  }}
                >
                  <option value=''>
                    {vmQuery.isPending || pool.isPending
                      ? '加载账号与槽位…'
                      : '请选择账号 + 槽位'}
                  </option>
                  {targets.map((t) => (
                    <option key={t.id} value={t.id} disabled={!t.account}>
                      {t.label}
                    </option>
                  ))}
                </select>
                {(vmQuery.isError || pool.isError) && (
                  <span role='alert' className='text-destructive'>
                    账号/槽位读取失败，请重新打开。
                  </span>
                )}
                {!target && draft.slot && (
                  <span className='text-amber-600'>
                    原账号或槽位绑定已变化，请重新选择。
                  </span>
                )}
                <span className='text-muted-foreground'>
                  未绑定账号的空槽不可选择。
                </span>
              </label>
              <label className='block space-y-2 text-xs'>
                检测模型
                <select
                  aria-label='检测模型'
                  className={cn(selectClass, 'w-full')}
                  value={draft.model}
                  disabled={!target || models.isPending || models.isError}
                  onChange={(e) => update({ model: e.target.value })}
                >
                  <option value=''>
                    {!target
                      ? '请先选择账号 + 槽位'
                      : models.isPending
                        ? '读取受支持模型…'
                        : '请选择受支持模型'}
                  </option>
                  {draft.model &&
                    !modelItems.some((m) => m.id === draft.model) && (
                      <option value={draft.model} disabled>
                        {draft.model}（已不可用，请重选）
                      </option>
                    )}
                  {modelItems.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label && m.label !== m.id
                        ? `${m.label} · ${m.id}`
                        : m.id}
                    </option>
                  ))}
                </select>
                {models.isError && (
                  <span role='alert' className='text-destructive'>
                    模型目录读取失败，请重新打开。
                  </span>
                )}
                {target && models.isSuccess && !modelItems.length && (
                  <span className='text-amber-600'>
                    该平台暂无受支持模型，请先在模型管理中配置。
                  </span>
                )}
                <span className='text-muted-foreground'>
                  读取该槽位平台的受支持模型表，不触发登录或模型调用。
                </span>
              </label>
            </section>
            <section className='space-y-4 border-t pt-5'>
              <h3 className='flex items-center gap-2 text-xs font-semibold'>
                <span className='flex size-5 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground'>
                  02
                </span>
                检测方式
              </h3>
              <div className='grid grid-cols-2 gap-3'>
                {(['probe', 'candy'] as const).map((kind) => (
                  <button
                    type='button'
                    key={kind}
                    aria-pressed={draft.kind === kind}
                    className={cn(
                      'relative rounded-lg border p-3 text-left transition-colors',
                      draft.kind === kind
                        ? 'border-primary/50 bg-primary/5'
                        : 'hover:bg-muted/40'
                    )}
                    onClick={() =>
                      update({
                        kind,
                        ...(kind === 'probe' ? { autoRestore: false } : {}),
                      })
                    }
                  >
                    <KindIcon
                      kind={kind}
                      className={cn(
                        'mb-2 size-5',
                        draft.kind === kind
                          ? 'text-primary'
                          : 'text-muted-foreground'
                      )}
                    />
                    <p className='text-sm font-medium'>
                      {kind === 'probe' ? '门票探针' : '糖果题检测'}
                    </p>
                    <p className='mt-1 text-[11px] text-muted-foreground'>
                      {kind === 'probe'
                        ? '仅 GPT OAuth · 两次完整请求'
                        : '题目可编辑，规则校验答案'}
                    </p>
                    {draft.kind === kind && (
                      <Check className='absolute top-3 right-3 size-3.5 text-primary' />
                    )}
                  </button>
                ))}
              </div>
              {draft.kind === 'candy' && (
                <div className='space-y-3 rounded-lg border bg-muted/20 p-4'>
                  <label className='flex flex-col gap-2 text-xs'>
                    思考强度
                    <select
                      aria-label='思考强度'
                      className={selectClass}
                      value={draft.reasoningEffort || 'medium'}
                      disabled={!/^(gpt-|codex)/i.test(draft.model)}
                      onChange={(event) =>
                        update({
                          reasoningEffort: event.target
                            .value as QualityTask['reasoningEffort'],
                        })
                      }
                    >
                      <option value='none'>模型默认（不指定）</option>
                      <option value='low'>low · 低</option>
                      <option value='medium'>medium · 中</option>
                      <option value='high'>high · 高</option>
                      <option value='xhigh'>xhigh · 更高</option>
                      <option value='max'>max</option>
                      <option value='ultra'>ultra</option>
                    </select>
                    <span className='text-muted-foreground'>
                      GPT 按所选强度发送；模型不支持时记录真实错误。Claude
                      沿用当前协议策略。
                    </span>
                  </label>
                  <div className='flex items-center justify-between'>
                    <span className='text-xs font-medium'>判定规则</span>
                    <span className='rounded bg-primary/10 px-2 py-0.5 text-[10px] text-primary'>
                      无需裁判模型
                    </span>
                  </div>
                  <label className='flex items-center gap-2 text-xs'>
                    <input
                      type='radio'
                      name='judge'
                      checked={draft.judge === 'answer'}
                      onChange={() => update({ judge: 'answer' })}
                      className='accent-emerald-500'
                    />
                    仅简短最终答案为 21
                  </label>
                  <label className='flex items-center gap-2 text-xs'>
                    <input
                      type='radio'
                      name='judge'
                      checked={draft.judge === 'contains'}
                      onChange={() => update({ judge: 'contains' })}
                      className='accent-emerald-500'
                    />
                    包含独立数字 21（支持完整解释）
                    <span className='text-muted-foreground'>默认</span>
                  </label>
                  <p className='text-[11px] leading-5 text-muted-foreground'>
                    {draft.judge === 'answer'
                      ? '支持“21”“答案是 21 颗糖果”等简短答案；拒绝 121、210 和矛盾回答。'
                      : '排除 121、210 和小数。解释或否定句里出现 21 仍可能通过。'}
                  </p>
                  <div className='space-y-2 border-t pt-3'>
                    <div className='flex items-center justify-between'>
                      <label htmlFor='candy-prompt' className='text-xs'>
                        糖果题目
                      </label>
                      <Button
                        type='button'
                        size='sm'
                        variant='ghost'
                        onClick={() => update({ prompt: CANDY_PROMPT })}
                      >
                        恢复 sub2 原文
                      </Button>
                    </div>
                    <Textarea
                      id='candy-prompt'
                      aria-label='糖果题目'
                      value={draft.prompt}
                      rows={9}
                      maxLength={10000}
                      onChange={(e) => update({ prompt: e.target.value })}
                      className='text-xs leading-6'
                    />
                    <p className='text-[11px] text-muted-foreground'>
                      原文来自 sub2
                      v2.17.3，保存时不追加提示词。修改随本任务持久保存；当前判定答案固定为
                      21，请保持题意一致。
                    </p>
                  </div>
                </div>
              )}
            </section>
            <section className='space-y-4 border-t pt-5'>
              <h3 className='flex items-center gap-2 text-xs font-semibold'>
                <span className='flex size-5 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground'>
                  03
                </span>
                执行与处理
              </h3>
              <div className='grid grid-cols-2 gap-3'>
                <label className='flex flex-col gap-2 text-xs'>
                  检测频率（分钟）
                  <Input
                    aria-label='检测频率（分钟）'
                    type='number'
                    min={1}
                    max={525600}
                    step={1}
                    required
                    value={draft.interval || ''}
                    onChange={(e) =>
                      update({ interval: Number(e.target.value) })
                    }
                  />
                </label>
                <label className='flex flex-col gap-2 text-xs'>
                  异常处理
                  <select
                    className={selectClass}
                    value={draft.action}
                    onChange={(event) =>
                      update({
                        action:
                          event.target.value === 'pause' ? 'pause' : 'record',
                        ...(event.target.value === 'pause'
                          ? {}
                          : { autoRestore: false }),
                      })
                    }
                  >
                    <option value='record'>仅记录，不修改调度</option>
                    <option value='pause'>检测不通过时关闭槽位调度</option>
                  </select>
                </label>
              </div>
              {draft.kind === 'candy' && draft.action === 'pause' && (
                <div className='space-y-1 rounded-lg border p-3'>
                  <label className='flex items-center gap-2 text-xs font-medium'>
                    <input
                      type='checkbox'
                      className='size-4 accent-emerald-500'
                      checked={draft.autoRestore === true}
                      onChange={(event) =>
                        update({ autoRestore: event.target.checked })
                      }
                    />
                    检测通过后自动恢复调度
                  </label>
                  <p className='pl-6 text-[11px] leading-5 text-muted-foreground'>
                    质量运维任务独立于槽位调度；即使槽位已关闭调度，仍按设定频率检测。开启后，只自动恢复本任务关闭的调度；人工关闭或其他故障状态不会被自动开启。
                  </p>
                </div>
              )}
              <label className='flex items-center justify-between rounded-lg border p-3 text-xs'>
                <span>
                  启用任务
                  <span className='ml-2 text-muted-foreground'>
                    按频率真实执行
                  </span>
                </span>
                <input
                  type='checkbox'
                  className='size-4 accent-emerald-500'
                  checked={draft.enabled}
                  onChange={(event) =>
                    update({ enabled: event.target.checked })
                  }
                />
              </label>
            </section>
            {error && (
              <p role='alert' className='text-xs text-destructive'>
                {error}
              </p>
            )}
          </form>
        )}
        <SheetFooter className='flex-row justify-end border-t px-6'>
          <Button variant='outline' onClick={onClose}>
            取消
          </Button>
          <Button
            form='quality-task-form'
            type='submit'
            disabled={
              saving || vmQuery.isError || pool.isError || models.isError
            }
          >
            <Check className='size-4' />
            {saving ? '保存中…' : '保存任务配置'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
