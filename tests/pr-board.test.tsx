import { expect, mock, test } from 'claude-code/testing'

import { bandLine, ciOf, items, parseRemote, parseRuns, reviewOf } from '../hooks/board'
import type { Board, Pull } from '../types'

// 시험 환경에는 있지만 타입 정의(lib)에는 없는 전역 함수
declare const setTimeout: (fn: (value?: unknown) => void, ms: number) => unknown

const at = (hm: string, day = '16') => `2026-11-${day}T${hm}:00Z`
const NOW = Date.parse(at('10:00'))
const SHA = { pr: 'a'.repeat(40), queue: 'b'.repeat(40), main: 'c'.repeat(40), old: 'd'.repeat(40) }

// 실제 Gitea 28 응답에서 쓰는 필드만 남긴 것
const PULLS = [
  {
    number: 12, title: '로그인 화면', head: { ref: 'feat/login', sha: SHA.pr }, base: { ref: 'main' }, user: { login: 'altair823' },
    draft: false, mergeable: true, updated_at: at('09:55'), requested_reviewers: [{ login: 'claude-reviewer-01' }],
  },
]
const REVIEWS = [
  { user: { login: 'claude-reviewer-01' }, state: 'REQUEST_REVIEW', stale: false, submitted_at: at('09:20') },
  { user: { login: 'claude-reviewer-01' }, state: 'REQUEST_CHANGES', stale: true, submitted_at: at('09:30') },
  { user: { login: 'claude-reviewer-01' }, state: 'APPROVED', stale: false, submitted_at: at('09:55') },
]
const run = (id: number, o: Record<string, unknown>) => ({
  id, display_title: `커밋 ${id}`, path: 'ci.yml@refs/heads/x', event: 'push', head_branch: null, pull_requests: [],
  status: 'completed', conclusion: 'success', created_at: at('09:00'), started_at: '1970-01-01T00:00:00Z', completed_at: '1970-01-01T00:00:00Z', ...o,
})
const job = (name: string, o: Record<string, unknown>) => ({ name, status: 'completed', conclusion: 'success', created_at: at('09:00'), started_at: at('09:00'), completed_at: at('09:01'), ...o })

const fixture = () => ({
  runs: [
    // PR에서 돈 실행은 브랜치 이름이 비고 PR 번호가 붙는다
    run(30, { event: 'pull_request', head_sha: SHA.pr, pull_requests: [{ number: 12 }], path: 'ci.yml@refs/pull/12/merge', status: 'in_progress', conclusion: null, created_at: at('09:51'), started_at: at('09:52') }),
    run(29, { head_branch: 'feat/queue', head_sha: SHA.queue, status: 'queued', conclusion: null, created_at: at('09:48') }),
    run(28, { head_branch: 'main', head_sha: SHA.main, created_at: at('09:00'), started_at: at('09:01'), completed_at: at('09:03') }),
    run(27, { head_branch: 'feat/login', head_sha: SHA.pr, created_at: at('09:50'), started_at: at('09:50'), completed_at: at('09:51') }),
    run(20, { head_branch: 'old/branch', head_sha: SHA.old, created_at: at('09:00', '14'), completed_at: at('09:05', '14') }),
  ],
  jobs: {
    30: [job('test', { created_at: at('09:51'), started_at: at('09:52'), completed_at: at('09:53') }), job('lint', { status: 'in_progress', conclusion: null, created_at: at('09:51'), started_at: at('09:53'), completed_at: null })],
    29: [job('test', { status: 'queued', conclusion: null, created_at: at('09:48'), started_at: '1970-01-01T00:00:00Z', completed_at: null })],
    // 조건이 맞지 않아 건너뛴 작업은 시작, 끝 시각이 없다
    28: [job('test', { started_at: at('09:01'), completed_at: at('09:03') }), job('release', { conclusion: 'skipped', started_at: '1970-01-01T00:00:00Z', completed_at: '1970-01-01T00:00:00Z' })],
    27: [job('test', {})],
  } as Record<number, unknown[]>,
})

// remote가 null이면 git 저장소가 아닌 디렉터리다. 시험 중에 seen.remote를 바꾸면 /cd로 옮긴 것과 같다.
// timers가 true면 시계를 직접 다루지 않는다(시험이 mock.clock을 쓴다).
function stubs(on: any, data = fixture(), remote: string | null = 'https://gitea.example.com/org/app.git', timers = false) {
  // 기본은 사람이 예전에 /pr-board로 패널을 연 상태다. 패널이 열려 있는 동안만 원격을 읽는다.
  const seen = { toasts: [] as string[], status: [] as unknown[], filled: [] as string[], api: [] as string[], opened: 0, closed: false, shown: true, remote, cwd: '/repo', store: { opened: true } as Record<string, unknown> }
  on('ui.panes', () => ({ value: seen.opened && !seen.closed ? [{ id: 'pr-board', title: 'PR', isShown: seen.shown, isFocused: false }] : [] }))
  on('session.cwd', () => ({ value: seen.cwd }))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: seen.store[e.key] }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => ((seen.store[e.key] = e.value), { value: undefined }))
  on('command.register', () => ({ value: { command: 'pr-board' } }))
  on('ui.open', () => (seen.opened++, { value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('ui.toast', (_: unknown, e: { text?: string }) => (seen.toasts.push(typeof e === 'string' ? e : String(e.text ?? JSON.stringify(e))), { value: undefined }))
  on('ui.status', (_: unknown, e: unknown) => (seen.status.push(e), { value: undefined }))
  on('prompt.fill', (_: unknown, e: { text: string }) => (seen.filled.push(e.text), { isFilled: true }))
  if (!timers) {
    on('clock.every', () => ({ deny: '시험에서는 타이머를 쓰지 않는다' }))
    on('clock.after', () => ({ deny: '시험에서는 타이머를 쓰지 않는다' }))
    on('clock.now', () => ({ value: NOW }))
  }
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'git' && seen.remote === null) return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === 'git') return ok(e.argv[1] === 'remote' ? `${seen.remote}\n` : 'main\n')
    const path = e.argv[2] ?? ''
    seen.api.push(path)
    if (path.endsWith('/pulls?state=open&limit=50')) return ok(JSON.stringify(PULLS))
    if (path.endsWith('/pulls/12/reviews')) return ok(JSON.stringify(REVIEWS))
    if (path.endsWith('/actions/runs?limit=50')) return ok(JSON.stringify({ workflow_runs: data.runs, total_count: data.runs.length }))
    const m = /\/actions\/runs\/(\d+)\/jobs$/.exec(path)
    if (m) return ok(JSON.stringify({ jobs: data.jobs[Number(m[1])] ?? [], total_count: 0 }))
    return ok('404 page not found')
  })
  return seen
}

// 입력창 위 줄. 그린 것이 없으면 undefined
const BAND = {
  plugin: 'pr-board', surface: 'terminal', component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const
async function band($: any): Promise<string | undefined> {
  const ui = await $.ui.mount(BAND)
  const t = await ui.find({ type: 'Text', text: /^CI / })
  await ui.unmount()
  // 줄 끝까지 공백으로 채워 그린다
  return t?.text.trimEnd()
}

const PANE = (surface: 'terminal' | 'desktop') => ({
  plugin: 'pr-board', surface, component: 'Pane', requestId: 'pr-board',
  props: { title: 'PR', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 24 }, view: {} },
}) as const
const settle = () => new Promise(r => setTimeout(r, 30))

test('원격 주소에서 호스트와 저장소를 읽는다', () => {
  expect(parseRemote('https://gitea.altair823.xyz/altair823-org/claude-pr-board.git')).toEqual({ host: 'gitea.altair823.xyz', repo: 'altair823-org/claude-pr-board' })
  expect(parseRemote('git@github.com:altair823/claude-git-graph.git')).toEqual({ host: 'github.com', repo: 'altair823/claude-git-graph' })
  expect(parseRemote('ssh://git@gitea.example.com:2222/org/app')).toEqual({ host: 'gitea.example.com', repo: 'org/app' })
  expect(parseRemote('/home/me/bare')).toBeUndefined()
})

test('열린 PR 줄과 PR이 없는 브랜치 줄을 만들고, 하루가 지난 브랜치는 뺀다', () => {
  const data = fixture()
  const pulls: Pull[] = [{ num: 12, title: '로그인 화면', branch: 'feat/login', base: 'main', sha: SHA.pr, author: 'me', draft: false, mergeable: true, updated: 0, requested: [], reviews: [] }]
  const runs = parseRuns({ workflow_runs: data.runs })
  const b: Board = { host: 'h', repo: 'org/app', branch: 'main', pulls, runs, fetched: NOW }
  const list = items(b, NOW)
  expect(list.map(it => it.key)).toEqual(['pr:12', 'br:feat/queue', 'br:main'])
  // PR 줄은 PR 끝 커밋에서 돈 실행 가운데 워크플로마다 가장 새 것(PR 이벤트로 돈 30번)
  expect(list[0]!.runs.map(r => r.id)).toEqual([30])
  expect(list[2]!.current).toBe(true)
  expect(ciOf(list[1]!.runs, NOW).segs.map(s => s.t).join('')).toBe('⏳ ci.yml 대기 12분')
})

test('앞 작업이 끝나야 시작하는 작업은 그 뒤부터 기다린 시간을 센다', () => {
  const [r] = parseRuns({ workflow_runs: [run(1, { status: 'in_progress', conclusion: null, created_at: at('09:00'), started_at: at('09:01') })] })
  r!.jobs = [
    { name: 'test', state: 'success', created: Date.parse(at('09:00')), started: Date.parse(at('09:01')), done: Date.parse(at('09:44')) },
    { name: 'release', state: 'queued', created: Date.parse(at('09:00')), started: 0, done: 0 },
  ]
  expect(ciOf([r!], NOW).segs.map(s => s.t).join('')).toBe('⏳ release 대기 16분')
})

test('리뷰는 리뷰어마다 마지막 결정을 보고, 새 커밋 전 리뷰는 요청 대기로 본다', () => {
  const p = (reviews: Pull['reviews'], requested: string[] = []): Pull =>
    ({ num: 1, title: '', branch: '', base: '', sha: '', author: '', draft: false, mergeable: true, updated: 0, requested, reviews })
  expect(reviewOf(p([{ user: 'bot', state: 'REQUEST_CHANGES', stale: false, t: 1 }, { user: 'bot', state: 'APPROVED', stale: false, t: 2 }]))?.t).toBe('승인')
  expect(reviewOf(p([{ user: 'bot', state: 'APPROVED', stale: false, t: 2 }, { user: 'bot', state: 'COMMENT', stale: false, t: 3 }]))?.t).toBe('승인')
  expect(reviewOf(p([{ user: 'bot', state: 'REQUEST_CHANGES', stale: true, t: 1 }], ['bot']))?.t).toBe('리뷰 대기')
  expect(reviewOf(p([]))).toBeUndefined()
})

test('패널에 PR과 브랜치의 CI, 리뷰를 그리고 커서 줄의 작업을 상세로 보여 준다', async ($, on) => {
  const seen = stubs(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(PANE(surface))
    expect((await ui.find({ key: 'r:pr:12' }))?.text).toMatch(/^ {2}#12 로그인 화면 +▶ lint 7분  승인$/)
    expect((await ui.find({ key: 'r:br:feat/queue' }))?.text).toMatch(/^ {2}feat\/queue {2}커밋 29 +⏳ test 대기 12분$/)
    expect((await ui.find({ key: 'r:br:main' }))?.text).toMatch(/^● main {2}커밋 28 +✓ 57분 전$/)
    expect(await ui.find({ key: 'r:br:old/branch' })).toBeUndefined()
    // 커서가 없으면 첫 줄(PR)의 상세
    expect((await ui.find({ type: 'Text', text: /feat\/login → main/ }))?.text).toMatch(/altair823$/)
    expect((await ui.find({ type: 'Text', text: /^승인 +claude-reviewer-01/ }))?.text).toMatch(/5분 전$/)
    expect((await ui.find({ type: 'Text', text: /^✓ test/ }))?.text.trim()).toBe('✓ test  1분')
    expect((await ui.find({ type: 'Text', text: /^▶ lint {2}/ }))?.text.trim()).toBe('▶ lint  7분째')
    await ui.unmount()
  }
  await $.ui.focus({ component: 'Pane', requestId: 'pr-board', element: 'r:br:main', origin: { kind: 'person' } })
  const ui = await $.ui.mount(PANE('terminal'))
  expect((await ui.find({ type: 'Text', text: /^main {2}c{7}/ }))?.text).toMatch(/실행 #28$/)
  expect((await ui.find({ type: 'Text', text: /release/ }))?.text.trim()).toBe('- release  건너뜀')
  await ui.unmount()
  // 끝난 실행의 작업은 다시 읽지 않는다
  const before = seen.api.filter(p => p.endsWith('/28/jobs')).length
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  await settle()
  expect(seen.api.filter(p => p.endsWith('/28/jobs')).length).toBe(before)
  expect(seen.api.filter(p => p.endsWith('/30/jobs')).length).toBe(2)
})

test('단축키는 커서 줄로 부탁하는 문장을 입력창에 넣는다', async ($, on) => {
  const seen = stubs(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'act:3' })
  await ui.press({ key: 'act:1' })
  expect(seen.filled).toEqual(['PR #12를 머지해 줘 ', 'PR #12의 리뷰 코멘트를 확인하고 반영해 줘 '])
  await ui.press({ key: 'act:2' })
  expect(seen.toasts.at(-1)).toBe('이 줄에는 실패한 CI가 없습니다')
  await $.ui.focus({ component: 'Pane', requestId: 'pr-board', element: 'r:br:main', origin: { kind: 'person' } })
  await ui.press({ key: 'act:3' })
  expect(seen.toasts.at(-1)).toBe('PR 줄에서 쓸 수 있습니다')
  await ui.unmount()
})

test('기다리던 CI가 끝나면 알리고, 실패한 작업을 고쳐 달라는 문장을 넣을 수 있다', async ($, on) => {
  const data = fixture()
  const seen = stubs(on, data)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect(seen.toasts).toEqual([])
  data.runs[1] = { ...data.runs[1]!, status: 'completed', conclusion: 'failure', started_at: at('09:58'), completed_at: at('09:59') }
  data.jobs[29] = [job('test', { conclusion: 'failure', created_at: at('09:48'), started_at: at('09:58'), completed_at: at('09:59') })]
  await $.tool.call({ tool: 'Bash', command: 'git push origin feat/queue' })
  await settle()
  expect(seen.toasts).toEqual(['feat/queue CI 실패: test'])
  await $.ui.focus({ component: 'Pane', requestId: 'pr-board', element: 'r:br:feat/queue', origin: { kind: 'person' } })
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'act:2' })
  expect(seen.filled).toEqual(['feat/queue 브랜치의 CI 실패 원인을 로그에서 찾아 고쳐 줘(실행 #29) '])
  await ui.unmount()
})

test('GitHub 저장소와 API 오류는 안내만 그린다', async ($, on) => {
  const seen = stubs(on, fixture(), 'git@github.com:me/app.git')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  // 보여 줄 수 없는 저장소라 자동으로 열지 않는다. /pr-board로 열면 안내가 보인다.
  expect(seen.opened).toBe(0)
  await $.command.run({ command: 'pr-board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  await settle()
  const ui = await $.ui.mount(PANE('terminal'))
  expect((await ui.find({ type: 'Text', text: /GitHub/ }))?.text).toContain('아직 지원하지 않습니다')
  await ui.unmount()
})

test('git 저장소가 아니면 안내만 그리고, 세션을 시작할 때 패널을 열지 않는다', async ($, on) => {
  const seen = stubs(on, fixture(), null)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect(seen.opened).toBe(0)
  // /pr-board로 직접 열면 연다
  await $.command.run({ command: 'pr-board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  await settle()
  expect(seen.opened).toBe(1)
  expect(seen.api).toEqual([])
  const ui = await $.ui.mount(PANE('terminal'))
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')).toBe('git 저장소가 아닙니다')
  await ui.unmount()
})

test('패널이 다른 탭에 가려지면 입력창 위에 CI 요약을 그리고, 보이거나 닫히면 뺀다', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = stubs(on, fixture(), undefined, true)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
  expect(await band($)).toBeUndefined()
  seen.shown = false
  await clock.advance(2000)
  expect(await band($)).toBe('CI ▶ #12 7분  ⏳ feat/queue 대기 12분')
  seen.closed = true
  await clock.advance(2000)
  expect(await band($)).toBeUndefined()
  // 상태줄은 쓰지 않는다(이전 버전이 남긴 줄을 지우는 호출뿐)
  expect(seen.status).toEqual([{ text: undefined }])
})

test('/cd로 저장소 밖으로 옮기면 바로 다시 읽어 안내로 바꾸고 CI 요약을 뺀다', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = stubs(on, fixture(), undefined, true)
  seen.shown = false
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  seen.remote = null
  await clock.advance(2000)
  // 디렉터리가 그대로면 주기 전에는 다시 읽지 않는다
  expect(await band($)).toMatch(/^CI ▶/)
  seen.cwd = '/'
  await clock.advance(2000)
  const ui = await $.ui.mount(PANE('terminal'))
  expect((await ui.find({ type: 'Text', text: /저장소/ }))?.text).toBe('git 저장소가 아닙니다')
  await ui.unmount()
  expect(await band($)).toBeUndefined()
})

test('패널을 열지 않은 세션은 원격을 읽지 않고, 열린 동안 CI가 없으면 5분마다 읽는다', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const data = fixture()
  const seen = stubs(on, data, undefined, true)
  seen.store.opened = false
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  await clock.advance(600_000)
  expect(seen.api).toEqual([])

  await $.command.run({ command: 'pr-board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  await clock.settle()
  const lists = () => seen.api.filter(p => p.endsWith('/pulls?state=open&limit=50')).length
  expect(lists()).toBe(1)
  // 도는 CI가 있으면 15초마다(타이머는 2초 단위)
  await clock.advance(16_000)
  expect(lists()).toBe(2)
  // 모두 끝나면 5분마다
  data.runs = data.runs.filter(r => r.status === 'completed')
  await clock.advance(16_000)
  expect(lists()).toBe(3)
  await clock.advance(60_000)
  expect(lists()).toBe(3)
  await clock.advance(300_000)
  expect(lists()).toBe(4)
  // 닫으면 더 읽지 않는다(이 시험 환경에는 $.ui.close가 없어 패널 목록만 비운다)
  seen.closed = true
  await clock.advance(600_000)
  expect(lists()).toBe(4)
})

test('CI 요약은 보여 줄 것이 없으면 비운다', () => {
  expect(bandLine([], NOW)).toBeUndefined()
})
