export const CANDY_PROMPT = `在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。现已知不同口味的糖和不同形状的数量统计如下表。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少个糖果才能保证手中同时拥有不同形状的苹果味和桃子味的糖？（同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果都满足要求）
苹果味 桃子味 西瓜味
圆形 7 9 8
五角星形 7 6 4`

export type CheckKind = 'candy' | 'probe'
export type JudgeMode = 'answer' | 'contains'
export type QualityTask = {
  id: string
  name: string
  account: string
  slot: string
  model: string
  prompt: string
  kind: CheckKind
  judge: JudgeMode
  interval: number
  enabled: boolean
  action: 'record' | 'pause'
  autoRestore: boolean
  reasoningEffort:
    'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
}
export type QualityRecord = {
  id: string
  taskId: string
  taskName: string
  account: string
  slot: string
  model: string
  prompt: string
  kind: CheckKind
  judge: JudgeMode
  time: string
  result: 'running' | 'passed' | 'failed' | 'error' | 'skipped'
  output: string
  latency: string
  action: string
  reasoningEffort?: string | null
  source?: 'manual' | 'scheduled'
  outputTruncated?: boolean
  probe?: {
    verdict: string
    failure?: string
    mint_status: number
    continue_status: number
    ticket_length: number
    continue_ticket_length: number
    new_ticket: boolean
    reported_model?: string
  }
}

export function judgeCandy(output: string, mode: JudgeMode): boolean {
  const normalized = output.normalize('NFKC').trim()
  if (mode === 'contains')
    return /(^|[^A-Za-z0-9_.+-])21(?![A-Za-z0-9_]|[.,][0-9])/u.test(normalized)
  if (/[0-9][\s*_]+[0-9]/u.test(normalized)) return false
  const answer = normalized.replace(/[\s*_`"'“”]/gu, '').toLowerCase()
  return /^(?:(?:最终)?(?:答案|结果)(?:为|是)?[:：]?|(?:最少|至少)(?:需要)?(?:取出|抽取|摸出)?|(?:需要|取出|抽取|摸出))?(?:21|二十一)(?:个|颗|粒)?(?:糖果|糖)?(?:即可)?[。.!！]?$|^(?:(?:the)?answer(?:is|:)?|atleast)?21(?:candies)?[.!]?$/.test(
    answer
  )
}

export function formatRecordTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}
export function formatRecordDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}
