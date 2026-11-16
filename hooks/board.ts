// Gitea API 응답을 목록 줄로 바꾸는 순수 함수 모음. 화면과 갱신은 register.tsx에 있다.
import type { Board, CiState, Job, Pull, Review, Run } from '../types'

export type Seg = { t: string; color?: string; dim?: true; bold?: true }

// 목록 한 줄: 열린 PR, 또는 PR이 없는 브랜치. runs는 그 줄의 마지막 커밋에서 돈 실행(워크플로마다 가장 새 것).
export type Item = {
  key: string
  num: number
  branch: string
  title: string
  runs: Run[]
  pull?: Pull
  current: boolean
}

// CI 요약. active는 대기 중이거나 실행 중인 작업이 있는지(상태줄과 끝남 알림에 쓴다).
export type Ci = { state: CiState; active: boolean; segs: Seg[]; since: number }

const DAY = 24 * 3600_000

const ms = (s: unknown) => {
  const t = typeof s === 'string' ? Date.parse(s) : 0
  return t > 0 ? t : 0
}

export function stateOf(status: unknown, conclusion?: unknown): CiState {
  if (status === 'completed') {
    if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure') return 'failure'
    return conclusion === 'cancelled' ? 'cancelled' : conclusion === 'skipped' ? 'skipped' : 'success'
  }
  if (status === 'in_progress' || status === 'running') return 'running'
  return status === 'queued' || status === 'waiting' || status === 'pending' || status === 'blocked' ? 'queued' : 'none'
}

// tea api 출력. 성공하면 JSON 값, API 오류면 그 메시지를 담은 Error를 던진다(tea는 오류에도 종료 코드 0을 낸다).
export function parseJson(out: string): unknown {
  let v: unknown
  try {
    v = JSON.parse(out)
  } catch {
    throw new Error(out.trim().split('\n').pop() || '응답이 비어 있습니다')
  }
  if (v && typeof v === 'object' && !Array.isArray(v) && 'message' in v && !('workflow_runs' in v) && !('jobs' in v)) {
    throw new Error(String((v as { message: unknown }).message))
  }
  return v
}

type J = Record<string, any>
const list = (v: unknown, key?: string): J[] => {
  const a = key ? (v as J | null)?.[key] : v
  return Array.isArray(a) ? a : []
}

export function parsePulls(v: unknown): Pull[] {
  return list(v).map(p => ({
    num: Number(p.number) || 0,
    title: String(p.title ?? ''),
    branch: String(p.head?.ref ?? ''),
    base: String(p.base?.ref ?? ''),
    sha: String(p.head?.sha ?? ''),
    author: String(p.user?.login ?? ''),
    draft: !!p.draft,
    mergeable: p.mergeable !== false,
    updated: ms(p.updated_at),
    requested: list(p.requested_reviewers).map(u => String(u.login ?? '')),
    reviews: [],
  }))
}

// 리뷰 요청 기록(REQUEST_REVIEW)과 작성 중인 리뷰(PENDING)는 뺀다.
export function parseReviews(v: unknown): Review[] {
  return list(v)
    .filter(r => r.state === 'APPROVED' || r.state === 'REQUEST_CHANGES' || r.state === 'COMMENT')
    .map(r => ({ user: String(r.user?.login ?? ''), state: r.state, stale: !!r.stale, t: ms(r.submitted_at) }))
}

export function parseRuns(v: unknown): Run[] {
  return list(v, 'workflow_runs').map(r => ({
    id: Number(r.id) || 0,
    title: String(r.display_title ?? ''),
    // path는 'ci.yml@refs/heads/main' 꼴이다.
    workflow: String(r.path ?? '').split('@')[0] ?? '',
    event: String(r.event ?? ''),
    branch: String(r.head_branch ?? ''),
    sha: String(r.head_sha ?? ''),
    pr: Number(list(r.pull_requests)[0]?.number) || 0,
    state: stateOf(r.status, r.conclusion),
    created: ms(r.created_at),
    started: ms(r.started_at),
    done: ms(r.completed_at),
  }))
}

export function parseJobs(v: unknown): Job[] {
  return list(v, 'jobs').map(j => ({
    name: String(j.name ?? ''),
    state: stateOf(j.status, j.conclusion),
    created: ms(j.created_at),
    started: ms(j.started_at),
    done: ms(j.completed_at),
  }))
}

// 원격 주소에서 호스트와 owner/repo. https, ssh(git@host:o/r, ssh://git@host:22/o/r) 모두 받는다.
export function parseRemote(url: string): { host: string; repo: string } | undefined {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[/:](.+?)(?:\.git)?\/?$/.exec(url.trim())
  if (!m || !m[2]?.includes('/')) return undefined
  return { host: m[1]!, repo: m[2] }
}

// 한 커밋에서 돈 실행 가운데 워크플로마다 가장 새 것만 남긴다(다시 실행한 것은 새 실행이다).
const latest = (runs: Run[]) => {
  const seen = new Set<string>()
  return runs.filter(r => !seen.has(r.workflow) && !!seen.add(r.workflow))
}

export function items(b: Board, now: number): Item[] {
  const runs = [...b.runs].sort((x, y) => y.id - x.id)
  const pulls = [...b.pulls].sort((x, y) => y.updated - x.updated)
  const out: Item[] = pulls.map(p => ({
    key: `pr:${p.num}`,
    num: p.num,
    branch: p.branch,
    title: p.title,
    runs: latest(runs.filter(r => r.sha === p.sha)),
    pull: p,
    current: p.branch === b.branch,
  }))
  // PR이 없는 브랜치: 마지막 실행이 아직 도는 중이거나 하루 안에 돈 브랜치. 지금 브랜치는 기간과 상관없이 보여 준다.
  const taken = new Set(pulls.map(p => p.branch))
  const byBranch = new Map<string, Run[]>()
  for (const r of runs) {
    if (!r.branch || taken.has(r.branch) || r.event.startsWith('pull_request')) continue
    byBranch.set(r.branch, [...(byBranch.get(r.branch) ?? []), r])
  }
  for (const [branch, list] of byBranch) {
    const head = list[0]!
    const mine = latest(list.filter(r => r.sha === head.sha))
    const active = mine.some(r => r.state === 'queued' || r.state === 'running')
    if (!active && now - head.created > DAY && branch !== b.branch) continue
    out.push({ key: `br:${branch}`, num: 0, branch, title: head.title, runs: mine, current: branch === b.branch })
  }
  return out
}

// 리뷰어마다 마지막 승인이나 변경 요청을 본다. 새 커밋 뒤라 지난 리뷰가 된 것(stale)은 빼고, 남은 것이 없으면 요청 대상으로 판단한다.
export function reviewOf(p: Pull): Seg | undefined {
  const last = new Map<string, Review>()
  for (const r of [...p.reviews].sort((x, y) => x.t - y.t)) if (r.state !== 'COMMENT') last.set(r.user, r)
  const live = [...last.values()].filter(r => !r.stale)
  if (live.some(r => r.state === 'REQUEST_CHANGES')) return { t: '변경 요청', color: 'red' }
  if (live.some(r => r.state === 'APPROVED')) return { t: '승인', color: 'green' }
  if (p.requested.length) return { t: '리뷰 대기', color: 'yellow' }
  if (p.reviews.some(r => !r.stale)) return { t: '코멘트', dim: true }
  return undefined
}

export function dur(d: number): string {
  const s = Math.max(0, Math.floor(d / 1000))
  if (s < 60) return `${s}초`
  if (s < 3600) return `${Math.floor(s / 60)}분`
  if (s < 86400) return `${Math.floor(s / 3600)}시간`
  return `${Math.floor(s / 86400)}일`
}

// 작업 목록. 아직 작업을 읽지 못한 실행은 실행 자체를 작업 하나로 본다.
export const jobsOf = (runs: Run[]): Job[] =>
  runs.flatMap(r => r.jobs ?? [{ name: r.workflow, state: r.state, created: r.created, started: r.started, done: r.done }])

// 대기는 작업이 생긴 때부터 센다. 앞 작업(needs)이 끝나야 시작하는 작업은 같은 실행에서 마지막으로 끝난 작업 뒤부터 센다.
export function waitFrom(job: Job, runs: Run[]): number {
  const run = runs.find(r => r.jobs?.includes(job))
  const before = (run?.jobs ?? []).reduce((t, j) => Math.max(t, j.done), 0)
  return Math.max(job.created, before)
}

const names = (jobs: Job[]) => (jobs.length > 1 ? `${jobs[0]!.name} 외 ${jobs.length - 1}개` : (jobs[0]?.name ?? ''))

export function ciOf(runs: Run[], now: number): Ci {
  if (!runs.length) return { state: 'none', active: false, segs: [{ t: 'CI 없음', dim: true }], since: 0 }
  const jobs = jobsOf(runs)
  const of = (s: CiState) => jobs.filter(j => j.state === s)
  const [failed, running, queued] = [of('failure'), of('running'), of('queued')]
  const active = running.length + queued.length > 0
  if (failed.length) return { state: 'failure', active, segs: [{ t: `✗ ${names(failed)}`, color: 'red' }], since: 0 }
  if (running.length) {
    const since = Math.min(...running.map(j => j.started || now))
    return { state: 'running', active, segs: [{ t: `▶ ${names(running)}`, color: 'cyan' }, { t: ` ${dur(now - since)}`, dim: true }], since }
  }
  if (queued.length) {
    const since = Math.min(...queued.map(j => waitFrom(j, runs)))
    return { state: 'queued', active, segs: [{ t: `⏳ ${names(queued)} 대기`, color: 'yellow' }, { t: ` ${dur(now - since)}`, dim: true }], since }
  }
  if (of('cancelled').length) return { state: 'cancelled', active, segs: [{ t: '⊘ 취소', dim: true }], since: 0 }
  const done = Math.max(...jobs.map(j => j.done))
  return { state: 'success', active, segs: [{ t: '✓', color: 'green' }, ...(done ? [{ t: ` ${dur(now - done)} 전`, dim: true as const }] : [])], since: done }
}

// 상세의 작업 한 줄
export function jobLine(j: Job, runs: Run[], now: number): Seg[] {
  if (j.state === 'queued') return [{ t: '⏳ ', color: 'yellow' }, { t: j.name }, { t: `  대기 ${dur(now - waitFrom(j, runs))}`, dim: true }]
  if (j.state === 'running') return [{ t: '▶ ', color: 'cyan' }, { t: j.name }, { t: `  ${dur(now - (j.started || now))}째`, dim: true }]
  if (j.state === 'skipped') return [{ t: `- ${j.name}  건너뜀`, dim: true }]
  const icon: Seg = j.state === 'failure' ? { t: '✗ ', color: 'red' } : j.state === 'cancelled' ? { t: '⊘ ', dim: true } : { t: '✓ ', color: 'green' }
  return [icon, { t: j.name }, ...(j.started && j.done ? [{ t: `  ${dur(j.done - j.started)}`, dim: true as const }] : [])]
}

// 줄 이름: PR은 번호와 제목, 브랜치는 이름.
export const labelOf = (it: Item): Seg[] =>
  it.pull ? [{ t: `#${it.num}`, color: 'yellow' }, { t: ` ${it.title}` }] : [{ t: it.branch, color: 'magenta' }, { t: `  ${it.title}`, dim: true }]

// 상태줄: 대기 중이거나 실행 중인 줄과, 지금 브랜치가 실패했으면 그것까지. 보여 줄 것이 없으면 undefined.
export function statusLine(list: Item[], now: number): string | undefined {
  const parts: string[] = []
  for (const it of list) {
    const ci = ciOf(it.runs, now)
    const name = it.pull ? `#${it.num}` : it.branch
    if (ci.state === 'failure' && (ci.active || it.current)) parts.push(`✗ ${name}`)
    else if (ci.state === 'running') parts.push(`▶ ${name} ${dur(now - ci.since)}`)
    else if (ci.state === 'queued') parts.push(`⏳ ${name} 대기 ${dur(now - ci.since)}`)
  }
  return parts.length ? `CI ${parts.join('  ')}` : undefined
}

// 칸 폭: 한글과 이모지는 두 칸
const cw = (ch: string) => {
  const c = ch.codePointAt(0) ?? 0
  if ((c >= 0x0300 && c <= 0x036f) || (c >= 0x200b && c <= 0x200f) || (c >= 0xfe00 && c <= 0xfe0f)) return 0
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff)
    ? 2
    : 1
}
export const width = (s: string) => [...s].reduce((n, ch) => n + cw(ch), 0)

// 왼쪽 구간을 cols칸에 맞춰 자르고 오른쪽 끝에 right를 붙인다(git-graph와 같은 방식).
export function fit(left: Seg[], right: Seg[], cols: number): Seg[] {
  if (right.reduce((n, s) => n + width(s.t), 0) > cols) right = fit(right, [], cols)
  const rw = right.reduce((n, s) => n + width(s.t), 0)
  const room = Math.max(0, cols - rw - (rw ? 1 : 0))
  const out: Seg[] = []
  let used = 0
  for (const s of left) {
    const w = width(s.t)
    if (used + w <= room) {
      out.push(s)
      used += w
      continue
    }
    if (room - used < 1) break
    let t = ''
    for (const ch of s.t) {
      if (used + width(t) + cw(ch) > room - 1) break
      t += ch
    }
    out.push({ ...s, t: t + '…' })
    used += width(t) + 1
    break
  }
  return [...out, { t: ' '.repeat(Math.max(0, cols - used - rw)) }, ...right]
}
