import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Job, PaneState, Review, View } from '../types'
import { bandLine, ciOf, dur, fit, isLive, items, jobLine, jobsOf, nameWidth, parseJobs, parseJson, parsePulls, parseRemote, parseReviews, parseRuns, reviewOf, rowLeft, rowRight, section, width } from './board'
import type { Item, Seg } from './board'

const PANE = 'pr-board'
// 상세 구역의 최대 줄 수(머리 줄 포함)
const DETAIL_ROWS = 7
// 커서가 있는 줄의 배경. 밝은 테마와 어두운 테마 모두에서 보이도록 테마 색을 쓴다.
const SEL_BG = 'subtle'
const EMPTY: Board = { host: '', repo: '', branch: '', pulls: [], runs: [], fetched: 0 }
// 저장 형태가 바뀌면 shape 값을 올린다. 이전 버전이 저장한 값은 버려진다.
const board = atom({ plugin: 'pr-board', key: 'board' } as const, EMPTY, { shape: 'board-1' })
const view = atom({ plugin: 'pr-board', key: 'view' } as const, { cur: '' } as View, { shape: 'view-1' })
// 패널이 가려져 있을 때만 입력창 위에 CI 요약을 그린다. 타이머가 2초마다 고친다.
const pane = atom({ plugin: 'pr-board', key: 'pane' } as const, 'closed' as PaneState)
// 사람이 /pr-board로 연 뒤 직접 닫지 않았으면 다음 세션에도 연다($.store에 남긴다).
const OPENED = 'opened'
// 인증이 없을 때 입력을 기다리며 멈추지 않게 한다.
const QUIET = { GIT_TERMINAL_PROMPT: '0' }
// 이 명령 뒤에는 원격 상태가 바뀌었을 수 있어 바로 다시 읽는다.
const REMOTE_CMD = /\bgit\s+push\b|\bgitea-|\btea\s/

// 끝난 실행의 작업 목록은 바뀌지 않아 기억한다. 리뷰는 PR의 갱신 시각이 그대로면 다시 읽지 않는다.
// ponytail: 모듈을 다시 불러오면 비워져 한 번 다시 읽는다. 500개를 넘으면 통째로 비운다.
const jobMemo = new Map<number, Job[]>()
const reviewMemo = new Map<string, Review[]>()

async function api($: EngineInterface, path: string): Promise<unknown> {
  const out = await $.process.run(['tea', 'api', path], { env: QUIET, timeoutMs: 20_000 }).catch(() => undefined)
  if (!out) throw new Error('tea CLI를 실행하지 못했습니다. tea를 설치하고 tea login add로 Gitea에 로그인해 주세요')
  if (out.exitCode !== 0) throw new Error((out.stderr || out.stdout).trim().split('\n').pop() || `tea 종료 코드 ${out.exitCode}`)
  return parseJson(out.stdout)
}

// git만 확인한다(네트워크를 쓰지 않는다). 오류가 없으면 PR과 CI를 읽을 수 있는 저장소다.
async function locate($: EngineInterface): Promise<Board> {
  const git = (args: string[]) => $.process.run(['git', ...args], { env: QUIET }).catch(() => undefined)
  // branch --show-current는 커밋이 없는 저장소에서도 성공하고, 저장소가 아니면 실패한다. 분리된 HEAD에서는 빈 줄이다.
  const [head, remote] = await Promise.all([git(['branch', '--show-current']), git(['remote', 'get-url', 'origin'])])
  if (!head) return { ...EMPTY, error: 'git을 실행하지 못했습니다' }
  if (head.exitCode !== 0) return { ...EMPTY, error: 'git 저장소가 아닙니다' }
  const branch = head.stdout.trim()
  if (remote?.exitCode !== 0) return { ...EMPTY, branch, error: 'origin 원격이 없습니다. origin이 Gitea 저장소를 가리키면 PR과 CI를 보여 줍니다' }
  const where = parseRemote(remote.stdout)
  if (!where) return { ...EMPTY, branch, error: `원격 주소를 읽지 못했습니다: ${remote.stdout.trim()}` }
  const base: Board = { ...EMPTY, ...where, branch }
  if (where.host === 'github.com') return { ...base, error: 'GitHub 저장소는 아직 지원하지 않습니다. 지금은 Gitea 저장소만 보여 줍니다' }
  return base
}

// 같은 저장소를 보는 세션들이 조회 결과를 나눠 쓰는 파일. 세션이 몇 개든 저장소마다 한 세션분만 조회한다.
// ponytail: 두 세션의 주기가 같은 순간에 돌아오면 둘 다 조회할 수 있다. 잦아지면 조회 중 표시 파일을 둔다.
async function cacheFile($: EngineInterface, b: Board): Promise<string | undefined> {
  const home = (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined))
  return home && b.host && b.repo ? `${home}/.cache/claude-pr-board/${b.host}/${b.repo}.json` : undefined
}
const mtimeOf = ($: EngineInterface, file: string) => $.fs.stat(file).then(st => st.mtimeMs, () => 0)
// 이 세션이 마지막으로 쓰거나 읽은 공유 파일의 수정 시각. 더 새 파일이 보이면 다른 세션이 읽은 것이다.
let seenMtime = 0

// 대기나 실행 중인 CI가 있으면 짧게, 없으면 길게 기다린다.
const dueIn = (b: Board, now: number) => (!b.error && items(b, now).some(it => ciOf(it.runs, now).active) ? ACTIVE_MS : IDLE_MS)

async function readShared($: EngineInterface, file: string, base: Board): Promise<Board | undefined> {
  const mtime = await mtimeOf($, file)
  if (!mtime) return undefined
  const b = await $.fs.read(file).then(t => JSON.parse(t) as Board, () => undefined)
  // 쓰는 도중에 읽어 깨졌거나 다른 저장소 것이면 쓰지 않는다.
  if (b?.repo !== base.repo || b.host !== base.host || !Array.isArray(b.pulls) || !Array.isArray(b.runs) || typeof b.fetched !== 'number') return undefined
  seenMtime = mtime
  return { ...b, branch: base.branch }
}

// force가 아니면 다른 세션이 최근에 읽은 결과를 먼저 쓴다. push 뒤나 r을 누르면 force로 서버에서 읽는다.
async function load($: EngineInterface, force = false): Promise<Board> {
  const base = await locate($)
  if (base.error) return base
  const file = await cacheFile($, base)
  if (!force && file) {
    const shared = await readShared($, file, base)
    const now = await $.clock.now()
    if (shared && now - shared.fetched < dueIn(shared, now) - 100) return shared
  }
  const R = `/repos/${base.repo}`
  try {
    const [pulls, runs] = await Promise.all([
      api($, `${R}/pulls?state=open&limit=50`).then(parsePulls),
      // Actions를 쓰지 않는 저장소는 실행 목록이 오류다. PR은 그대로 보여 준다.
      api($, `${R}/actions/runs?limit=50`).then(parseRuns, () => []),
    ])
    if (reviewMemo.size > 500) reviewMemo.clear()
    if (jobMemo.size > 500) jobMemo.clear()
    await Promise.all(
      pulls.map(async p => {
        const k = `${p.num}@${p.updated}`
        const hit = reviewMemo.get(k)
        if (hit) return void (p.reviews = hit)
        const got = await api($, `${R}/pulls/${p.num}/reviews`).then(parseReviews, () => undefined)
        if (got) reviewMemo.set(k, (p.reviews = got))
      }),
    )
    const now = await $.clock.now()
    const next: Board = { ...base, pulls, runs, fetched: now }
    // 목록에 나오는 실행의 작업만 읽는다. 다시 실행하면 같은 실행 번호로 다시 돌므로, 기억한 작업은 끝난 실행에만 쓴다.
    const shown = new Set(items(next, now).flatMap(it => it.runs.map(r => r.id)))
    await Promise.all(
      runs
        .filter(r => shown.has(r.id))
        .map(async r => {
          const done = !isLive(r.state)
          const hit = done ? jobMemo.get(r.id) : undefined
          if (hit) return void (r.jobs = hit)
          const jobs = await api($, `${R}/actions/runs/${r.id}/jobs`).then(parseJobs, () => undefined)
          if (!jobs) return
          r.jobs = jobs
          if (done) jobMemo.set(r.id, jobs)
        }),
    )
    if (file) {
      await $.fs.write(file, JSON.stringify({ ...next, branch: '' })).catch(() => {})
      seenMtime = await mtimeOf($, file)
    }
    return next
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
}

// 줄마다 지난번에 본 CI 진행 여부와 리뷰 결과. 처음 읽을 때(undefined)는 알림을 띄우지 않는다.
// 다른 저장소로 옮기면 처음부터 다시 본다(두 저장소의 같은 PR 번호를 같은 줄로 보지 않게).
let seen: Map<string, { active: boolean; review: string }> | undefined
let seenRepo = ''

// 대기나 실행이 끝난 줄과 새 리뷰 결과를 알린다. 패널이 다른 탭에 가려져 있어도 알 수 있게 한다.
function notify($: EngineInterface, b: Board, now: number) {
  if (b.repo !== seenRepo) [seen, seenRepo] = [undefined, b.repo]
  const list = b.error ? [] : items(b, now)
  const next = new Map<string, { active: boolean; review: string }>()
  for (const it of list) {
    const ci = ciOf(it.runs, now)
    const review = it.pull ? (reviewOf(it.pull)?.t ?? '') : ''
    const was = seen?.get(it.key)
    const name = it.pull ? `#${it.num}` : it.branch
    if (was?.active && !ci.active) {
      const failed = jobsOf(it.runs).filter(j => j.state === 'failure').map(j => j.name)
      $.ui.toast(failed.length ? `${name} CI 실패: ${failed.join(', ')}` : ci.state === 'cancelled' ? `${name} CI 취소` : `${name} CI 성공`)
    }
    if (was && review !== was.review && (review === '승인' || review === '변경 요청')) $.ui.toast(`${name} 리뷰: ${review}`)
    next.set(it.key, { active: ci.active, review })
  }
  seen = next
}

// 갱신이 겹치면 하나로 합친다. 도는 중에 다시 요청되면 끝난 뒤 한 번 더 읽는다.
let busy = false
let again = false
let forced = false
let lastEnd = 0
// 마지막으로 읽은 디렉터리. /cd로 바뀌면 주기를 기다리지 않고 다시 읽는다(/cd에는 CwdChanged 훅이 불리지 않는다).
let lastCwd = ''
async function refresh($: EngineInterface, force = false) {
  forced ||= force
  if (busy) {
    again = true
    return
  }
  busy = true
  try {
    do {
      again = false
      const f = forced
      forced = false
      lastCwd = await $.session.cwd()
      const next = await load($, f)
      await update($, board, () => next)
      lastEnd = await $.clock.now()
      notify($, next, lastEnd)
    } while (again)
  } finally {
    busy = false
  }
}

const isOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

// 원격 서버 부하를 줄이려고 패널을 연 세션에서만 읽는다(다른 탭에 가려져 있어도 연 것이다).
// 대기나 실행 중인 CI가 있으면 15초, 없으면 5분마다 읽고, push 같은 명령 뒤에는 바로 읽는다.
const ACTIVE_MS = 15_000
const IDLE_MS = 300_000

// 타이머는 2초마다 깨어나 패널 상태, 디렉터리, 공유 파일이 바뀌었는지만 본다(원격을 읽지 않는다).
async function tick($: EngineInterface) {
  const p = (await $.ui.panes()).find(x => x.id === PANE)
  const where: PaneState = !p ? 'closed' : p.isShown ? 'shown' : 'hidden'
  if ((await read($, pane)) !== where) await update($, pane, () => where)
  if (!p) return
  const [b, now, cwd] = await Promise.all([read($, board), $.clock.now(), $.session.cwd()])
  const file = b.error ? undefined : await cacheFile($, b)
  const shared = file !== undefined && (await mtimeOf($, file)) > seenMtime
  if (cwd !== lastCwd || shared || now - lastEnd >= dueIn(b, now) - 100) await refresh($)
}

let ticker: { cancel: () => void } | undefined

const open = ($: EngineInterface, focus?: true) => $.ui.open({ id: PANE, title: 'PR', ...(focus && { focus }) })

// 클릭으로도 패널에 키보드가 들어오게 한다. 입력창이 비어 있을 때만 받아들여지는 요청이다.
async function focusPane($: EngineInterface, key?: string) {
  await open($, true)
  if (key) await $.ui.focus({ requestId: PANE, key }).catch(() => {})
}

async function current($: EngineInterface): Promise<Item | undefined> {
  const [b, v, now] = await Promise.all([read($, board), read($, view), $.clock.now()])
  const list = items(b, now)
  return list.find(it => it.key === v.cur) ?? list[0]
}

// 커서가 있는 줄로 부탁하는 문장을 만들어 입력창에 넣는다. 보내기는 사람이 한다.
type Kind = 'review' | 'fix' | 'merge'
export function sayFor(it: Item, kind: Kind): string | undefined {
  const pr = it.pull ? `PR #${it.num}` : ''
  if (kind === 'review') return pr && `${pr}의 리뷰 코멘트를 확인하고 반영해 줘`
  if (kind === 'merge') return pr && `${pr}를 머지해 줘`
  const run = it.runs.find(r => jobsOf([r]).some(j => j.state === 'failure'))
  return run && `${pr ? `${pr}(${it.branch})` : `${it.branch} 브랜치`}의 CI 실패 원인을 로그에서 찾아 고쳐 줘(실행 #${run.id})`
}

async function ask($: EngineInterface, kind: Kind) {
  const it = await current($)
  const text = it && sayFor(it, kind)
  if (!text) return $.ui.toast(kind === 'fix' ? '이 줄에는 실패한 CI가 없습니다' : 'PR 줄에서 쓸 수 있습니다')
  const filled = await $.prompt.fill({ text: `${text} `, mode: 'insert' })
  $.ui.toast(filled.isFilled ? '입력창에 넣었습니다. Esc로 입력창에 돌아가 보내세요' : '입력창에 넣지 못했습니다')
}

const REVIEW_KO: Record<string, string> = { APPROVED: '승인', REQUEST_CHANGES: '변경 요청', COMMENT: '코멘트' }
const REVIEW_COLOR: Record<string, string> = { APPROVED: 'green', REQUEST_CHANGES: 'red' }

// 상세의 한 줄: 흐린 항목 이름 열과 값
const LABEL = 8
const field = (label: string, value: Seg[]): Seg[] => [{ t: `  ${label}${' '.repeat(LABEL - width(label))}`, dim: true }, ...value]

export function detailLines(it: Item | undefined, now: number, cols: number): Seg[][] {
  if (!it) return [[{ t: '줄을 고르면 PR과 CI의 상세가 여기에 나옵니다', dim: true }]]
  const p = it.pull
  const run = it.runs[0]
  const out: Seg[][] = [section(p ? `#${p.num}` : it.branch, cols)]
  if (p) {
    const flags: Seg[] = [...(p.draft ? [{ t: '  draft', dim: true as const }] : []), ...(p.mergeable ? [] : [{ t: '  충돌', color: 'red' }])]
    out.push(field('브랜치', [{ t: `${p.branch} → ${p.base}` }, ...flags]), field('작성자', [{ t: p.author }]))
    // 리뷰어마다 마지막 리뷰 하나. 새 커밋 전에 남긴 리뷰는 흐리게 그린다.
    const last = new Map<string, Review>()
    for (const r of [...p.reviews].sort((x, y) => x.t - y.t)) last.set(r.user, r)
    const rows: Seg[][] = [...last.values()].slice(-2).map(r => [
      { t: `${r.user} ` },
      { t: REVIEW_KO[r.state] ?? r.state, ...(r.stale ? { dim: true as const } : { color: REVIEW_COLOR[r.state] }) },
      { t: `  ${dur(now - r.t)} 전${r.stale ? ', 이전 커밋' : ''}`, dim: true },
    ])
    if (!rows.length && p.requested.length) rows.push([{ t: `${p.requested.join(', ')} 요청됨`, color: 'yellow' }])
    rows.forEach((r, i) => out.push(field(i ? '' : '리뷰', r)))
  } else {
    out.push(field('커밋', [{ t: run ? `${run.sha.slice(0, 7)}  ` : '', dim: true }, { t: it.title }]))
    if (run) out.push(field('실행', [{ t: `#${run.id}`, dim: true }]))
  }
  const jobs = jobsOf(it.runs).map(j => jobLine(j, it.runs, now))
  if (!jobs.length) return [...out, field('CI', [{ t: '이 커밋에서 돈 CI가 없습니다', dim: true }])].slice(0, DETAIL_ROWS)
  // 한 줄에 들어가면 작업을 나란히, 아니면 한 줄에 하나씩 쓴다.
  const inline = jobs.flatMap((j, i) => (i ? [{ t: '    ' }, ...j] : j))
  if (width(inline.map(s => s.t).join('')) <= cols - LABEL - 2) return [...out, field('CI', inline)].slice(0, DETAIL_ROWS)
  const room = DETAIL_ROWS - out.length
  const fits = jobs.length > room ? jobs.slice(0, Math.max(0, room - 1)) : jobs
  fits.forEach((j, i) => out.push(fit(field(i ? '' : 'CI', j), [], cols)))
  if (fits.length < jobs.length) out.push(field('', [{ t: `작업 ${jobs.length - fits.length}개 더`, dim: true }]))
  return out.slice(0, DETAIL_ROWS)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'pr-board', description: 'PR과 CI 상태 패널 열기' })
    // 0.1.1까지는 CI 요약을 상태줄에 두었다. 다시 불러온 세션에 남은 줄을 지운다.
    $.ui.status(undefined)
    // git-graph처럼 보여 줄 수 있는 저장소에서만 연다. 저장소가 아니면 /pr-board로 직접 열 때만 안내가 보인다.
    // 네트워크를 기다리느라 세션 시작이 늦어지지 않게 읽기는 끝을 기다리지 않는다.
    if ((await $.store.get(OPENED).catch(() => undefined)) === true && !(await locate($)).error) {
      void open($).catch(() => {})
      void refresh($).catch(() => {})
    }
    ticker?.cancel()
    ticker = $.clock.every(2000, () => void tick($).catch(() => {}))
    return started
  })

  on('command.run', { command: 'pr-board' }, async $ => {
    await $.store.set(OPENED, true).catch(() => {})
    void refresh($, true).catch(() => {})
    await open($, true)
    return { text: 'PR 패널을 열었습니다. Esc로 입력창에 돌아옵니다.' }
  })

  // 사람이 직접 닫으면 다음 세션에는 열지 않는다. 닫으면 더 읽지 않으므로 입력창 위 요약도 바로 뺀다.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await $.store.set(OPENED, false).catch(() => {})
    const done = await next(e)
    seen = undefined
    await update($, pane, () => 'closed')
    return done
  })

  // 패널이 다른 탭에 가려져 있을 때 입력창 위에 CI 요약 한 줄을 그린다. 상태줄은 Claude Code가 앞에 ⚠를 붙여 쓰지 않는다.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [b, where, now] = await Promise.all([read($, board), read($, pane), $.clock.now()])
    const line = where === 'hidden' && !b.error && !e.props.hasSurvey ? bandLine(items(b, now), now) : undefined
    if (!line) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text>{fit(line, [], Math.max(10, e.props.bodyColumns - 1)).map(s => <Text color={s.color} dimColor={s.dim} backgroundColor={s.bg}>{s.t}</Text>)}</Text>
  })

  // push나 PR 작업 뒤에는 바로 읽고, CI 실행이 만들어질 때쯤 한 번 더 읽는다.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.tool === 'Bash' && REMOTE_CMD.test(e.command) && (await isOpen($).catch(() => false))) {
      void refresh($, true).catch(() => {})
      try {
        $.clock.after(3000, () => void refresh($, true).catch(() => {}))
      } catch {}
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const el = e.element
    // 방향키와 Tab이 아래 단축키 버튼으로 넘어가지 않게 한다. 단축키는 글자 키나 클릭으로 누른다.
    if (el?.startsWith('act:') && e.origin.kind === 'person') return {}
    const done = await next(e)
    if (el?.startsWith('r:')) await update($, view, () => ({ cur: el.slice(2) }))
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [b, v, now] = await Promise.all([read($, board), read($, view), $.clock.now()])
    // 마지막 칸에 글자를 쓰면 줄이 넘어갈 수 있어 한 칸 남긴다.
    const cols = Math.max(20, e.props.bodyColumns - 1)
    const total = Math.max(4, e.props.scroll.bodyRows)
    const segs = (list: Seg[]) => list.map(s => <Text color={s.color} dimColor={s.dim} weight={s.bold && 'bold'} backgroundColor={s.bg}>{s.t}</Text>)
    const blank = <Text> </Text>
    const slash = b.repo.lastIndexOf('/')
    const title: Seg[] = b.repo ? [{ t: b.repo.slice(0, slash + 1), dim: true }, { t: b.repo.slice(slash + 1), bold: true }] : [{ t: '저장소 확인 중', bold: true }]
    // 오류일 때 "불러오는 중"은 맞지 않는다. 원격을 읽었으면 저장소 이름만 두고, 아니면 안내만 그린다.
    if (b.error) {
      return (
        <Box flexDirection="column">
          {b.repo && <Text>{segs(fit(title, [], cols))}</Text>}
          <Text dimColor>{b.error}</Text>
        </Box>
      )
    }

    const list = items(b, now)
    const prs = list.filter(it => it.pull)
    const brs = list.filter(it => !it.pull)
    // 열린 PR 구역과 브랜치 구역. 구역 머리와 사이의 빈 줄도 목록 줄로 센다.
    type Row = { item: Item } | { segs: Seg[] }
    const rows: Row[] = [
      ...(prs.length ? [{ segs: section(`열린 PR ${prs.length}`, cols) }, ...prs.map(item => ({ item }))] : []),
      ...(prs.length && brs.length ? [{ segs: [] }] : []),
      ...(brs.length ? [{ segs: section(`브랜치 ${brs.length}`, cols) }, ...brs.map(item => ({ item }))] : []),
    ]
    // 머리 1줄, 빈 줄과 상세, 빈 줄과 단축키. 패널이 낮으면 상세부터 뺀다.
    const hasActions = total >= 10
    const hasDetail = total >= 18 && list.length > 0
    const room = Math.max(2, total - 1 - (hasDetail ? DETAIL_ROWS + 1 : 0) - (hasActions ? 2 : 0))
    const shown = rows.length > room ? rows.slice(0, room - 1) : rows
    const hidden = list.length - shown.filter(r => 'item' in r).length
    const cur = list.find(it => it.key === v.cur) ?? list[0]
    const first = shown.find((r): r is { item: Item } => 'item' in r)?.item
    const ring = shown.some(r => 'item' in r && r.item.key === cur?.key) ? cur?.key : first?.key
    const widths = { pr: nameWidth(prs), br: nameWidth(brs) }
    const press = async (it: Item) => {
      void focusPane($, `r:${it.key}`)
      await update($, view, () => ({ cur: it.key }))
    }
    // 단축키는 테두리가 있는 버튼으로 그린다(plain 버튼은 엔진이 "1:"을 앞에 붙인다). 커서 줄에서 쓸 수 없는 것은 흐리게 둔다.
    const act = (hotkey: string, label: string, usable: boolean, onPress: () => unknown) => (
      <Button key={`act:${hotkey}`} hotkey={hotkey} onPress={() => void focusPane($).catch(() => {}).then(() => onPress())}>
        <Text color="suggestion" weight="bold" dimColor={!usable}>{hotkey}</Text>
        <Text dimColor={!usable}>{` ${label}`}</Text>
      </Button>
    )
    const gap = <Text> </Text>
    const failed = !!cur && jobsOf(cur.runs).some(j => j.state === 'failure')
    const hint = cols >= 70 ? (e.props.isFocused ? 'Esc 나가기' : 'ctrl+x tab') : ''

    return (
      <Box flexDirection="column">
        <Text>{segs(fit(title, [{ t: b.fetched ? `갱신 ${dur(now - b.fetched)} 전` : '불러오는 중', dim: true }], cols))}</Text>
        {!list.length && b.fetched > 0 && <Text dimColor>열린 PR이 없고, 하루 안에 CI가 돈 브랜치도 없습니다</Text>}
        {shown.map(r => {
          if (!('item' in r)) return r.segs.length ? <Text>{segs(r.segs)}</Text> : blank
          const it = r.item
          const ci = ciOf(it.runs, now)
          const line = fit(rowLeft(it, ci, it.pull ? widths.pr : widths.br), rowRight(ci, it.pull && reviewOf(it.pull)), cols)
          // 커서 줄은 배경을 깔고, 배경 위에서 잘 보이도록 흐린 글자를 보통 글자로 그린다.
          const drawn = it.key === cur?.key ? line.map(({ dim, ...s }) => ({ ...s, bg: SEL_BG })) : line
          return (
            <Button key={`r:${it.key}`} plain autoFocus={it.key === ring || undefined} onPress={() => void press(it)}>
              {segs(drawn)}
            </Button>
          )
        })}
        {hidden > 0 && <Text dimColor>{`  외 ${hidden}개`}</Text>}
        {hasDetail && blank}
        {hasDetail && detailLines(cur, now, cols).map(l => <Text>{segs(l)}</Text>)}
        {hasActions && blank}
        {hasActions && (
          <Box flexDirection="row" justifyContent="space-between" width={cols}>
            <Box flexDirection="row">
              {act('1', '리뷰 반영', !!cur?.pull, () => ask($, 'review'))}{gap}{act('2', 'CI 고치기', failed, () => ask($, 'fix'))}{gap}
              {act('3', '머지', !!cur?.pull, () => ask($, 'merge'))}{gap}{act('r', '새로 고침', true, () => refresh($, true))}
            </Box>
            {hint && <Text dimColor>{hint}</Text>}
          </Box>
        )}
      </Box>
    )
  })
}
