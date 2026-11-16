import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Job, PaneState, Review, View } from '../types'
import { bandLine, ciOf, dur, fit, items, jobLine, jobsOf, labelOf, parseJobs, parseJson, parsePulls, parseRemote, parseReviews, parseRuns, reviewOf } from './board'
import type { Item, Seg } from './board'

const PANE = 'pr-board'
const DETAIL_ROWS = 7
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

async function load($: EngineInterface): Promise<Board> {
  const base = await locate($)
  if (base.error) return base
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
          const done = r.state !== 'queued' && r.state !== 'running'
          const hit = done ? jobMemo.get(r.id) : undefined
          if (hit) return void (r.jobs = hit)
          const jobs = await api($, `${R}/actions/runs/${r.id}/jobs`).then(parseJobs, () => undefined)
          if (!jobs) return
          r.jobs = jobs
          if (done) jobMemo.set(r.id, jobs)
        }),
    )
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
let lastEnd = 0
// 마지막으로 읽은 디렉터리. /cd로 바뀌면 주기를 기다리지 않고 다시 읽는다(/cd에는 CwdChanged 훅이 불리지 않는다).
let lastCwd = ''
async function refresh($: EngineInterface) {
  if (busy) {
    again = true
    return
  }
  busy = true
  try {
    do {
      again = false
      lastCwd = await $.session.cwd()
      const next = await load($)
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
// ponytail: 같은 저장소를 연 세션이 여럿이면 각자 읽는다. 부하가 문제가 되면 $.store로 결과를 나눠 쓴다.
const ACTIVE_MS = 15_000
const IDLE_MS = 300_000

// 타이머는 2초마다 깨어나 패널 상태와 디렉터리가 바뀌었는지만 본다(원격을 읽지 않는다).
async function tick($: EngineInterface) {
  const p = (await $.ui.panes()).find(x => x.id === PANE)
  const where: PaneState = !p ? 'closed' : p.isShown ? 'shown' : 'hidden'
  if ((await read($, pane)) !== where) await update($, pane, () => where)
  if (!p) return
  const active = [...(seen?.values() ?? [])].some(x => x.active)
  const moved = (await $.session.cwd()) !== lastCwd
  if (moved || (await $.clock.now()) - lastEnd >= (active ? ACTIVE_MS : IDLE_MS) - 100) await refresh($)
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

export function detailLines(it: Item | undefined, now: number, cols: number): Seg[][] {
  if (!it) return [[{ t: '줄을 고르면 PR과 CI의 상세가 여기에 나옵니다', dim: true }]]
  const out: Seg[][] = []
  const p = it.pull
  if (p) {
    const flags: Seg[] = [...(p.draft ? [{ t: '  draft', dim: true as const }] : []), ...(p.mergeable ? [] : [{ t: '  충돌', color: 'red' }])]
    out.push(fit([{ t: `#${p.num}`, color: 'yellow' }, { t: `  ${p.branch} → ${p.base}`, dim: true }, ...flags], [{ t: p.author, dim: true }], cols))
    out.push(fit([{ t: p.title, bold: true }], [], cols))
    // 리뷰어마다 마지막 리뷰 하나. 새 커밋 전에 남긴 리뷰는 흐리게 그린다.
    const last = new Map<string, Review>()
    for (const r of [...p.reviews].sort((x, y) => x.t - y.t)) last.set(r.user, r)
    for (const r of [...last.values()].slice(-2)) {
      const color = r.state === 'APPROVED' ? 'green' : r.state === 'REQUEST_CHANGES' ? 'red' : undefined
      out.push(fit([{ t: REVIEW_KO[r.state] ?? r.state, color, ...(r.stale && { dim: true as const }) }, { t: `  ${r.user}`, dim: true }], [{ t: `${dur(now - r.t)} 전${r.stale ? ', 이전 커밋' : ''}`, dim: true }], cols))
    }
    if (!last.size && p.requested.length) out.push([{ t: `리뷰 요청: ${p.requested.join(', ')}`, dim: true }])
  } else {
    const run = it.runs[0]
    out.push(fit([{ t: it.branch, color: 'magenta' }, { t: `  ${run?.sha.slice(0, 7) ?? ''}`, dim: true }], run ? [{ t: `실행 #${run.id}`, dim: true }] : [], cols))
    out.push(fit([{ t: it.title, bold: true }], [], cols))
  }
  const jobs = jobsOf(it.runs)
  if (!jobs.length) out.push([{ t: '이 커밋에서 돈 CI가 없습니다', dim: true }])
  const room = DETAIL_ROWS - out.length
  const fits = jobs.length > room ? jobs.slice(0, Math.max(0, room - 1)) : jobs
  for (const j of fits) out.push(fit(jobLine(j, it.runs, now), [], cols))
  if (fits.length < jobs.length) out.push([{ t: `작업 ${jobs.length - fits.length}개 더`, dim: true }])
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
    void refresh($).catch(() => {})
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
    return <Text>{fit(line, [], Math.max(10, e.props.bodyColumns - 1)).map(s => <Text color={s.color} dimColor={s.dim}>{s.t}</Text>)}</Text>
  })

  // push나 PR 작업 뒤에는 바로 읽고, CI 실행이 만들어질 때쯤 한 번 더 읽는다.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.tool === 'Bash' && REMOTE_CMD.test(e.command) && (await isOpen($).catch(() => false))) {
      void refresh($).catch(() => {})
      try {
        $.clock.after(3000, () => void refresh($).catch(() => {}))
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
    const segs = (list: Seg[]) => list.map(s => <Text color={s.color} dimColor={s.dim} weight={s.bold && 'bold'}>{s.t}</Text>)
    const rule = <Text dimColor>{'─'.repeat(cols)}</Text>
    const header = fit([{ t: b.repo || '저장소 확인 중', bold: true }], [{ t: b.fetched ? `갱신 ${dur(now - b.fetched)} 전` : '불러오는 중', dim: true }], cols)
    // 오류일 때 "불러오는 중"은 맞지 않는다. 원격을 읽었으면 저장소 이름만 두고, 아니면 안내만 그린다.
    if (b.error) {
      return (
        <Box flexDirection="column">
          {b.repo && <Text>{segs(fit([{ t: b.repo, bold: true }], [], cols))}</Text>}
          <Text dimColor>{b.error}</Text>
        </Box>
      )
    }

    const list = items(b, now)
    // 머리 1줄, 구분선 2줄, 단축키와 안내 2줄, 상세. 패널이 낮으면 상세부터 뺀다.
    const hasActions = total >= 10
    const hasDetail = total >= 16
    const room = Math.max(1, total - 2 - (hasActions ? 2 : 0) - (hasDetail ? DETAIL_ROWS + 1 : 0))
    const shown = list.length > room ? list.slice(0, Math.max(1, room - 1)) : list
    const cur = list.find(it => it.key === v.cur) ?? list[0]
    const ring = shown.some(it => it.key === cur?.key) ? cur?.key : shown[0]?.key
    const press = async (it: Item) => {
      void focusPane($, `r:${it.key}`)
      await update($, view, () => ({ cur: it.key }))
    }
    const act = (hotkey: string, label: string, onPress: () => unknown) => (
      <Button key={`act:${hotkey}`} plain hotkey={hotkey} onPress={() => void focusPane($).catch(() => {}).then(() => onPress())}>{label}</Button>
    )
    const gap = <Text>  </Text>
    const hint: Seg[] = e.props.isFocused
      ? [{ t: '↑↓ 이동  Esc 입력창으로  ctrl+x x 닫기', dim: true }]
      : [{ t: 'ctrl+x tab', color: 'cyan' }, { t: ' 또는 클릭으로 들어오기  ', dim: true }, { t: '/pr-board', color: 'cyan' }]

    return (
      <Box flexDirection="column">
        <Text>{segs(header)}</Text>
        {rule}
        {!list.length && b.fetched > 0 && <Text dimColor>열린 PR이 없고, 하루 안에 CI가 돈 브랜치도 없습니다</Text>}
        {shown.map(it => {
          const ci = ciOf(it.runs, now)
          const review = it.pull && reviewOf(it.pull)
          const mark: Seg = it.current ? { t: '● ', color: 'cyan' } : { t: '  ' }
          const line = fit([mark, ...labelOf(it)], [...ci.segs, ...(review ? [{ t: '  ' }, review] : [])], cols)
          return (
            <Button key={`r:${it.key}`} plain autoFocus={it.key === ring || undefined} onPress={() => void press(it)}>
              {segs(line)}
            </Button>
          )
        })}
        {shown.length < list.length && <Text dimColor>{`  외 ${list.length - shown.length}개`}</Text>}
        {hasDetail && rule}
        {hasDetail && detailLines(cur, now, cols).map(l => <Text>{segs(l)}</Text>)}
        {hasActions && (
          <Box flexDirection="row">
            {act('1', '리뷰 반영', () => ask($, 'review'))}{gap}{act('2', 'CI 고치기', () => ask($, 'fix'))}{gap}
            {act('3', '머지', () => ask($, 'merge'))}{gap}{act('r', '새로 고침', () => refresh($))}
          </Box>
        )}
        {hasActions && <Text>{segs(fit(hint, [], cols))}</Text>}
      </Box>
    )
  })
}
