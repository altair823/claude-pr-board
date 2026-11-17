// Gitea와 GitHub API 응답을 목록 줄로 바꾸는 순수 함수 모음. 화면과 갱신은 register.tsx에 있다.
// GitHub REST API의 실행과 작업 응답은 Gitea와 같은 모양이라 같은 함수로 읽는다.
import type { Board, CiState, Job, Pull, Review, Run } from '../types'

export type Seg = { t: string; color?: string; dim?: true; bold?: true; bg?: string }

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

// CI 요약. active는 아직 끝나지 않은 작업이 있는지(조회 주기와 끝남 알림에 쓴다).
// mark는 줄 맨 앞의 상태 기호, note는 오른쪽 시간 열에 쓰는 말이다.
export type Ci = { state: CiState; active: boolean; mark: Seg; note: Seg; since: number }

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
  if (status === 'queued') return 'queued'
  // 앞 작업(needs)이 끝나기를 기다리는 작업. Gitea 28.1은 requested(소스상 pending도 있다), 1.26까지는 waiting으로 준다.
  return status === 'requested' || status === 'pending' || status === 'waiting' || status === 'blocked' ? 'blocked' : 'none'
}

export const isLive = (s: CiState) => s === 'queued' || s === 'running' || s === 'blocked'

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

// GitHub의 PR 목록(gh api graphql). 한 번에 리뷰어마다 마지막 리뷰와 PR 끝 커밋의 CI 결과(작업마다 하나인 check run)까지 받아서,
// PR마다 리뷰나 작업 목록을 따로 묻지 않는다. CI 결과 계산이 가장 무거워서 최근에 바뀐 PR GH_PR_LIMIT개만 읽는다(패널에 보이는 수보다 많다).
// 충돌 여부(mergeable)는 묻지 않는다. 물으면 GitHub가 PR마다 병합 가능 여부를 다시 계산하는 작업을 시작한다.
export const GH_PR_LIMIT = 30
export const GH_PR_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${GH_PR_LIMIT}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title headRefName headRefOid baseRefName isDraft updatedAt author { login }
        reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
        latestReviews(first: 10) { nodes { author { login } state submittedAt } }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
          __typename
          ... on CheckRun { name status conclusion startedAt completedAt detailsUrl }
          ... on StatusContext { context state createdAt }
        } } } } } }
      }
    }
  }
}`

// GitHub는 새 커밋을 올려도 승인과 변경 요청이 그대로 남으므로(저장소에서 따로 설정하지 않으면) 지난 리뷰로 보지 않는다.
const GH_REVIEW: Record<string, string> = { APPROVED: 'APPROVED', CHANGES_REQUESTED: 'REQUEST_CHANGES', COMMENTED: 'COMMENT' }
// 외부 CI가 남긴 커밋 상태(StatusContext)
const GH_STATUS: Record<string, CiState> = { SUCCESS: 'success', FAILURE: 'failure', ERROR: 'failure', PENDING: 'running', EXPECTED: 'blocked' }

export function parseGhPulls(v: unknown): Pull[] {
  return list((v as J | null)?.data?.repository?.pullRequests, 'nodes').map(p => ({
    num: Number(p.number) || 0,
    title: String(p.title ?? ''),
    branch: String(p.headRefName ?? ''),
    base: String(p.baseRefName ?? ''),
    sha: String(p.headRefOid ?? ''),
    author: String(p.author?.login ?? ''),
    draft: !!p.isDraft,
    mergeable: true,
    updated: ms(p.updatedAt),
    // 팀에 요청한 리뷰는 login 대신 팀 이름이 온다
    requested: list(p.reviewRequests, 'nodes').map(r => String(r.requestedReviewer?.login ?? r.requestedReviewer?.name ?? '')),
    reviews: list(p.latestReviews, 'nodes')
      .filter(r => GH_REVIEW[r.state])
      .map(r => ({ user: String(r.author?.login ?? ''), state: GH_REVIEW[r.state]!, stale: false, t: ms(r.submittedAt) })),
    runs: checkRuns(list(list(p.commits, 'nodes')[0]?.commit?.statusCheckRollup?.contexts, 'nodes'), String(p.headRefOid ?? '')),
  }))
}

// check run을 워크플로 실행마다 묶는다. 실행 번호는 detailsUrl(.../actions/runs/<번호>/job/<번호>)에 있고, 커밋 상태는 0번으로 묶는다.
// check run에는 만들어진 시각이 없어 시작 시각을 쓴다. 대기 중이라 시작 시각이 없으면 기다린 시간을 쓰지 않는다.
function checkRuns(nodes: J[], sha: string): Run[] {
  const runs = new Map<number, Run>()
  for (const c of nodes) {
    const id = Number(/\/actions\/runs\/(\d+)/.exec(String(c.detailsUrl ?? ''))?.[1]) || 0
    const job: Job =
      c.__typename === 'StatusContext'
        ? { name: String(c.context ?? ''), state: GH_STATUS[c.state] ?? 'none', created: ms(c.createdAt), started: ms(c.createdAt), done: 0 }
        : {
            name: String(c.name ?? ''),
            state: stateOf(String(c.status ?? '').toLowerCase(), String(c.conclusion ?? '').toLowerCase()),
            created: ms(c.startedAt),
            started: ms(c.startedAt),
            done: ms(c.completedAt),
          }
    const run = runs.get(id) ?? { id, title: '', workflow: '', event: 'pull_request', branch: '', sha, pr: 0, state: 'none', created: 0, started: 0, done: 0, jobs: [] }
    run.jobs!.push(job)
    run.state = run.jobs!.some(j => isLive(j.state)) ? 'running' : run.jobs!.some(j => j.state === 'failure') ? 'failure' : 'success'
    runs.set(id, run)
  }
  return [...runs.values()]
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
    // path는 Gitea가 'ci.yml@refs/heads/main', GitHub가 '.github/workflows/ci.yml' 꼴이다.
    workflow: String(r.path ?? '').split('@')[0]!.split('/').pop() ?? '',
    event: String(r.event ?? ''),
    branch: String(r.head_branch ?? ''),
    sha: String(r.head_sha ?? ''),
    pr: Number(list(r.pull_requests)[0]?.number) || 0,
    state: stateOf(r.status, r.conclusion),
    created: ms(r.created_at),
    // GitHub의 실행에는 시작 시각 이름이 다르고 끝난 시각이 없다. 끝난 실행은 마지막으로 바뀐 시각을 쓴다.
    started: ms(r.started_at ?? r.run_started_at),
    done: ms(r.completed_at) || (r.status === 'completed' ? ms(r.updated_at) : 0),
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
    // GitHub는 PR 목록에 함께 온 CI 결과를 쓴다
    runs: p.runs ?? latest(runs.filter(r => r.sha === p.sha)),
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
    const active = mine.some(r => isLive(r.state))
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

// 시작 시각을 모르는 대기(GitHub의 대기 중인 check run)는 기다린 시간을 쓰지 않는다
const waited = (t: number, now: number) => (t ? `대기 ${dur(now - t)}` : '대기')

// 목록 줄의 작업 이름. GitHub의 matrix 작업처럼 긴 이름이 제목을 밀어내지 않게 자른다.
const clip = (s: string, n: number) => (width(s) <= n ? s : fit([{ t: s }], [], n)[0]!.t)
const names = (jobs: Job[]) => (jobs.length > 1 ? `${clip(jobs[0]!.name, 14)} 외 ${jobs.length - 1}개` : clip(jobs[0]?.name ?? '', 14))

// 상세에서 작업이 한 줄에 다 들어가지 않을 때 먼저 쓰는 순서
const RANK: CiState[] = ['failure', 'running', 'queued', 'blocked', 'cancelled', 'success', 'skipped', 'none']
export const ranked = (jobs: Job[]) => [...jobs].sort((x, y) => RANK.indexOf(x.state) - RANK.indexOf(y.state))

export function ciOf(runs: Run[], now: number): Ci {
  if (!runs.length) return { state: 'none', active: false, mark: { t: '-', dim: true }, note: { t: 'CI 없음', dim: true }, since: 0 }
  const jobs = jobsOf(runs)
  const of = (s: CiState) => jobs.filter(j => j.state === s)
  const [failed, running, queued] = [of('failure'), of('running'), of('queued')]
  const active = jobs.some(j => isLive(j.state))
  if (failed.length) return { state: 'failure', active, mark: { t: '✗', color: 'red' }, note: { t: `${names(failed)} 실패`, color: 'red' }, since: 0 }
  if (running.length) {
    const since = Math.min(...running.map(j => j.started || now))
    return { state: 'running', active, mark: { t: '▶', color: 'cyan' }, note: { t: `${names(running)} ${dur(now - since)}`, dim: true }, since }
  }
  if (queued.length) {
    const since = Math.min(...queued.map(j => waitFrom(j, runs)))
    return { state: 'queued', active, mark: { t: '◌', color: 'yellow' }, note: { t: waited(since, now), color: 'yellow' }, since }
  }
  // 앞 작업이 막 끝나 다음 작업이 아직 대기열에 들어가지 않은 짧은 순간
  if (active) return { state: 'queued', active, mark: { t: '◌', dim: true }, note: { t: '다음 작업 준비', dim: true }, since: now }
  if (of('cancelled').length) return { state: 'cancelled', active, mark: { t: '⊘', dim: true }, note: { t: '취소', dim: true }, since: 0 }
  const done = Math.max(...jobs.map(j => j.done))
  return { state: 'success', active, mark: { t: '✓', color: 'green' }, note: { t: done ? `${dur(now - done)} 전` : '', dim: true }, since: done }
}

// 상세의 작업 하나. 앞 작업을 기다리는 작업은 러너 대기와 구분해 무엇 뒤에 도는지 보여 준다.
export function jobLine(j: Job, runs: Run[], now: number): Seg[] {
  if (j.state === 'queued') return [{ t: '◌ ', color: 'yellow' }, { t: j.name }, { t: `  ${waited(waitFrom(j, runs), now)}`, dim: true }]
  if (j.state === 'running') return [{ t: '▶ ', color: 'cyan' }, { t: j.name }, { t: `  ${dur(now - (j.started || now))}째`, dim: true }]
  if (j.state === 'blocked') {
    const ahead = (runs.find(r => r.jobs?.includes(j))?.jobs ?? []).filter(x => x.state === 'running' || x.state === 'queued')
    return [{ t: `◌ ${j.name}  ${ahead.length === 1 ? ahead[0]!.name : '앞 작업'} 뒤`, dim: true }]
  }
  if (j.state === 'skipped') return [{ t: `- ${j.name}  건너뜀`, dim: true }]
  const icon: Seg = j.state === 'failure' ? { t: '✗ ', color: 'red' } : j.state === 'cancelled' ? { t: '⊘ ', dim: true } : { t: '✓ ', color: 'green' }
  return [icon, { t: j.name }, ...(j.started && j.done ? [{ t: `  ${dur(j.done - j.started)}`, dim: true as const }] : [])]
}

const COL = 10
const padR = (s: Seg, n: number): Seg => ({ ...s, t: s.t + ' '.repeat(Math.max(0, n - width(s.t))) })
const padL = (s: Seg, n: number): Seg => ({ ...s, t: ' '.repeat(Math.max(0, n - width(s.t))) + s.t })

// 구역 머리: 이름 뒤로 줄을 긋는다.
export const section = (label: string, cols: number): Seg[] => [
  { t: `${label} `, dim: true, bold: true },
  { t: '─'.repeat(Math.max(0, cols - width(label) - 1)), color: 'subtle' },
]

// 줄 이름(PR 번호나 브랜치 이름)의 폭. 같은 구역 안에서 제목이 같은 열에서 시작하게 맞춘다.
export const nameWidth = (list: Item[]) => Math.min(24, Math.max(0, ...list.map(it => width(it.pull ? `#${it.num}` : it.branch))) + 2)

// 목록 한 줄의 왼쪽: 지금 브랜치 표시, 상태 기호, 줄 이름, 제목
export function rowLeft(it: Item, ci: Ci, w: number): Seg[] {
  const mark: Seg = it.current ? { t: '● ', color: 'cyan' } : { t: '  ' }
  return [mark, ci.mark, { t: ' ' }, padR({ t: it.pull ? `#${it.num}` : it.branch }, w), { t: it.title, ...(!it.pull && { dim: true as const }) }]
}

// 오른쪽: 시간 열과 리뷰 열. 리뷰가 없는 줄도 리뷰 열을 비워 두어 시간 열을 맞춘다.
export const rowRight = (ci: Ci, review: Seg | undefined): Seg[] => [padL(ci.note, COL), padL(review ?? { t: '' }, COL)]

const nameOf = (it: Item) => (it.pull ? `#${it.num}` : it.branch)

// 입력창 위 CI 요약. 지금 브랜치가 돌고 있거나 실패했으면 그것을 먼저 쓰고 나머지는 개수만 센다.
// 지금 브랜치에 보여 줄 것이 없으면 도는 줄을 하나씩 쓴다. 보여 줄 것이 없으면 undefined.
export function bandLine(list: Item[], now: number): Seg[] | undefined {
  const cur = list.find(it => it.current)
  const ci = cur && ciOf(cur.runs, now)
  const others = list.filter(it => it !== cur).map(it => ({ it, ci: ciOf(it.runs, now) }))
  if (cur && ci && (ci.active || ci.state === 'failure')) {
    const count = (s: CiState) => others.filter(o => o.ci.state === s).length
    const [run, wait] = [count('running'), count('queued')]
    const rest: Seg[] = run + wait ? [{ t: '    다른 줄', dim: true }, ...(run ? [{ t: ` 실행 ${run}`, color: 'cyan' }] : []), ...(wait ? [{ t: ` 대기 ${wait}`, color: 'yellow' }] : [])] : []
    return [{ t: '● ', color: 'cyan' }, { t: `${nameOf(cur)} ` }, ci.mark, { t: ' ' }, ci.note, ...rest]
  }
  const parts = others
    .filter(o => o.ci.state === 'running' || o.ci.state === 'queued' || (o.ci.state === 'failure' && o.ci.active))
    .map(o => [o.ci.mark, { t: ` ${nameOf(o.it)} ` }, o.ci.note])
  return parts.length ? [{ t: 'CI ', dim: true }, ...parts.flatMap((p, i) => (i ? [{ t: '  ' }, ...p] : p))] : undefined
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
