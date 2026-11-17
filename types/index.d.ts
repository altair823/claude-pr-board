// CI 상태를 한 가지로 줄인 것. queued는 러너를 기다리는 작업, blocked는 앞 작업(needs)이 끝나기를 기다리는 작업,
// skipped는 조건이 맞지 않아 건너뛴 작업이고, none은 실행이 없거나 알 수 없는 상태다.
export type CiState = 'queued' | 'blocked' | 'running' | 'success' | 'failure' | 'cancelled' | 'skipped' | 'none'

// 시각은 모두 ms. 아직 일어나지 않았으면 0이다.
export type Job = { name: string; state: CiState; created: number; started: number; done: number }

// workflow: 워크플로 파일 이름(ci.yml), pr: PR 이벤트로 돈 실행의 PR 번호(아니면 0),
// jobs: 읽은 작업 목록(아직 읽지 않았으면 없다)
export type Run = {
  id: number
  title: string
  workflow: string
  event: string
  branch: string
  sha: string
  pr: number
  state: CiState
  created: number
  started: number
  done: number
  jobs?: Job[]
}

export type Review = { user: string; state: string; stale: boolean; t: number }

// requested: 리뷰를 요청받은 사람
export type Pull = {
  num: number
  title: string
  branch: string
  base: string
  sha: string
  author: string
  draft: boolean
  mergeable: boolean
  updated: number
  requested: string[]
  reviews: Review[]
}

// repo: owner/repo, branch: 지금 체크아웃한 로컬 브랜치, fetched: 마지막으로 읽은 시각(ms)
export type Board = { host: string; repo: string; branch: string; pulls: Pull[]; runs: Run[]; fetched: number; error?: string }

// cur: 커서가 있는 줄의 key
export type View = { cur: string }

// 이 세션의 PR 패널: 닫힘, 열렸지만 다른 탭에 가려짐, 화면에 보임
export type PaneState = 'closed' | 'hidden' | 'shown'

declare module 'claude-code' {
  interface PluginState {
    'pr-board': { board: Shaped<Board>; view: Shaped<View>; pane: PaneState }
  }
}
