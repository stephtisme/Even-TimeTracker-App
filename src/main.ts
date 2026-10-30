import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

/**
 * TimeTracker — pick a task to start its timer; only one task runs at a time.
 *
 * Screens: tasks -> reports -> custom range -> date picker.
 *
 * Why there is no native list here: Even's display docs say lists have "no
 * row-height control" and "no in-place updates", so a timer column beside a
 * list can never be guaranteed to line up with its rows. Every row here is a
 * plain text line instead, and the timer for a row sits on the SAME line
 * number in a second text container with identical top, padding and font, so
 * they align by construction. The ">" cursor is drawn by this app.
 *
 * Input (same gestures as the text-reader sample):
 *   swipe up / swipe down  -> move the cursor (or change a value in the picker)
 *   click                  -> select
 *   double-click           -> back (exits from the Tasks screen)
 *
 * Needs checking in the simulator: that up/down input moves the ">" cursor.
 * Scroll events arrive as SCROLL_TOP_EVENT / SCROLL_BOTTOM_EVENT, as in the
 * reader sample, but I haven't seen them fire in this app yet.
 */

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

// Tasks are configured in the companion editor (rendered on this same page).
// These are only the first-run defaults; ids 0-4 must stay as they are so
// older sessions keep pointing at the right task.
const DEFAULT_TASKS = ['Meetings', 'Brief Write-up', 'Gym', 'Housework', 'Watching TV']
// Long press arrives as eventType 10 (seen in the simulator's event data).
const LONG_PRESS_EVENT = 10
const MAX_TASKS = 15 // the task list scrolls; the report body pages
const MENU_ROWS = 8 // ~27px per line in the 248px menu
const REPORT_ROWS = 6 // task lines per report page
const MAX_NAME = 20 // report column widened so "Name - 12h 59m" should still fit on one line

// Seeds a few past days of sample sessions once, so Reports has something
// to show. Set to false for a clean slate (and clear localStorage to remove).
const SEED_DEMO_DATA = false

// There is no bold on the glasses. Emphasis comes from bordered boxes around
// the report title and total. As an extra, set this to true to dim the report
// body so the boxed lines stand out. It sends `textColor` (0-4), which Even's
// docs list as SDK 0.0.14+ — upgrade the SDK and raise min_sdk_version in
// app.json before turning it on, or the simulator may reject the field.
const DIM_BODY_TEXT = false

// In the date picker, does swiping up raise the value (like arrow-up in a
// browser date field)? Flip to false if it feels backwards.
const SCROLL_UP_INCREASES = true

// ---------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------

type Session = { task: number; start: number; end: number; demo?: boolean }
type Running = { task: number; start: number }

const K_SESSIONS = 'tt_sessions'
const K_RUNNING = 'tt_running'
const K_HEARTBEAT = 'tt_heartbeat'
const K_SEEDED = 'tt_seeded'
const K_TASKS = 'tt_tasks'
const K_VIEW = 'tt_view'
const K_SETTINGS = 'tt_settings'

// Set true to print every input event to the console (to diagnose list bounce).
const DEBUG_EVENTS = false

type Task = { id: number; name: string; archived?: boolean }

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable — keep running in memory */
  }
}

function loadTasks(): Task[] {
  const saved = readJSON<Task[] | null>(K_TASKS, null)
  if (Array.isArray(saved) && saved.every((t) => typeof t?.id === 'number' && typeof t?.name === 'string')) return saved
  return DEFAULT_TASKS.map((name, id) => ({ id, name }))
}

type Settings = { focusExit: 'tasks' | 'reports'; focusTimer: boolean }
const loadSettings = (): Settings => ({ focusExit: 'tasks', focusTimer: true, ...readJSON<Partial<Settings>>(K_SETTINGS, {}) })
let settings: Settings = loadSettings()

let tasks: Task[] = loadTasks()
const active = (): Task[] => tasks.filter((t) => !t.archived)
const names = (): string[] => active().map((t) => t.name)

let sessions: Session[] = readJSON<Session[]>(K_SESSIONS, [])
let running: Running | null = null

// If the app was closed mid-timer, end that session at the last heartbeat
// instead of counting the time it was closed.
{
  const left = readJSON<Running | null>(K_RUNNING, null)
  if (left) {
    const lastBeat = readJSON<number>(K_HEARTBEAT, left.start)
    if (lastBeat > left.start) sessions.push({ task: left.task, start: left.start, end: lastBeat })
    writeJSON(K_SESSIONS, sessions)
    localStorage.removeItem(K_RUNNING)
  }
}

if (SEED_DEMO_DATA && sessions.length === 0 && !localStorage.getItem(K_SEEDED)) {
  const pattern: [number, number, number, number][] = [
    [0, 9, 30, 50], [1, 10, 30, 75], [2, 18, 0, 45], [3, 19, 0, 30], [4, 20, 30, 60],
  ]
  for (let back = 1; back <= 6; back++) {
    for (const [task, h, m, dur] of pattern) {
      const d = new Date()
      d.setDate(d.getDate() - back)
      d.setHours(h, m, 0, 0)
      const start = d.getTime()
      sessions.push({ task, start, end: start + (dur + ((back * 7) % 20)) * 60000 })
    }
  }
  writeJSON(K_SESSIONS, sessions)
  localStorage.setItem(K_SEEDED, '1')
}

// ---------------------------------------------------------------------
// Demo week — fills last week and this week (up to now) with realistic
// sessions so Reports looks alive in a recording. Demo sessions are tagged
// and regenerated each day; anything you track yourself is never touched.
// Set DEMO_WEEK to false to stop adding it (existing demo sessions are
// removed on the next launch).
// ---------------------------------------------------------------------
const DEMO_WEEK = false
const K_DEMO = 'tt_demo_week'

// DEMO-START
// [task position in the list, start hour, start minute, minutes]
const DEMO_WEEKDAY: [number, number, number, number][] = [
  [2, 6, 30, 50], // Gym
  [0, 9, 0, 60], // Meetings
  [1, 10, 15, 75], // Brief Write-up
  [3, 12, 30, 30], // Housework
  [0, 13, 30, 90], // Meetings
  [1, 15, 30, 60], // Brief Write-up
  [3, 18, 30, 25], // Housework
  [4, 20, 0, 90], // Watching TV
]
const DEMO_WEEKEND: [number, number, number, number][] = [
  [2, 9, 0, 60],
  [3, 11, 0, 90],
  [4, 14, 0, 120],
  [1, 16, 30, 45],
]

function demoSessions(now: number, taskIds: number[]): Session[] {
  const out: Session[] = []
  const first = addDays(startOfWeek(now), -7) // last Monday
  for (let day = first; day <= now; day = addDays(day, 1)) {
    const dow = new Date(day).getDay() // 0 = Sunday
    const plan = dow === 0 || dow === 6 ? DEMO_WEEKEND : DEMO_WEEKDAY
    plan.forEach(([pos, hh, mm, dur], n) => {
      const id = taskIds[pos]
      if (id === undefined) return
      if (pos === 2 && dow === 2) return // no gym on Tuesdays
      const jitter = ((dow * 7 + n * 5 + pos * 3) % 17) - 6 // varies by day, same every run
      const d = new Date(day)
      d.setHours(hh, mm, 0, 0)
      const start = d.getTime()
      const end = start + Math.max(10, dur + jitter) * 60000
      if (end > now) return // never invent time that hasn't happened yet
      out.push({ task: id, start, end, demo: true })
    })
  }
  return out
}
// DEMO-END

{
  const stamp = String(startOfDay(Date.now()))
  const had = sessions.some((x) => x.demo)
  if ((DEMO_WEEK && localStorage.getItem(K_DEMO) !== stamp) || (!DEMO_WEEK && had)) {
    sessions = sessions.filter((x) => !x.demo)
    if (DEMO_WEEK) sessions.push(...demoSessions(Date.now(), active().map((t) => t.id)))
    writeJSON(K_SESSIONS, sessions)
    localStorage.setItem(K_DEMO, stamp)
  }
}

// ---------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function addDays(ts: number, n: number): number {
  const d = new Date(ts)
  d.setDate(d.getDate() + n)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function startOfWeek(ts: number): number {
  const d = new Date(startOfDay(ts))
  return addDays(ts, -((d.getDay() + 6) % 7)) // weeks start Monday
}

function daysIn(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function fmtDateY(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// "Oct 1 to Oct 3" within this year; compact numeric dates across years.
function fmtRange(a: number, b: number): string {
  if (startOfDay(a) === startOfDay(b)) return fmtDate(a)
  const year = new Date().getFullYear()
  if (new Date(a).getFullYear() === year && new Date(b).getFullYear() === year) {
    return `${fmtDate(a)} to ${fmtDate(b)}`
  }
  const num = (t: number) => {
    const d = new Date(t)
    return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`
  }
  return `${num(a)} to ${num(b)}`
}

function fmtClock(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function fmtShort(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`
}

// Time per task inside [from, to], counting the running session up to now.
function totalsFor(from: number, to: number): number[] {
  const act = active()
  const byId = new Map<number, number>(act.map((t) => [t.id, 0]))
  const all: Session[] = running ? [...sessions, { task: running.task, start: running.start, end: Date.now() }] : sessions
  for (const s of all) {
    // sessions of removed (archived) tasks stay on disk but are not reported
    if (byId.has(s.task)) byId.set(s.task, byId.get(s.task)! + Math.max(0, Math.min(s.end, to) - Math.max(s.start, from)))
  }
  return act.map((t) => byId.get(t.id)!)
}

// ---------------------------------------------------------------------
// Companion editor — the phone-side page. Rendered BEFORE the bridge is
// awaited, so it shows even if the glasses connection is slow or absent.
// ---------------------------------------------------------------------

let onTasksChanged: () => void = () => {}

function saveTasks(next: Task[]) {
  tasks = next
  writeJSON(K_TASKS, tasks)
  renderEditor()
  onTasksChanged()
}

function cleanName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME)
}

function h(tag: string, attrs: Record<string, any> = {}, ...kids: (Node | string)[]): HTMLElement {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (v === true) e.setAttribute(k, '')
    else if (v !== false && v != null) e.setAttribute(k, String(v))
  }
  for (const kid of kids) e.append(kid)
  return e
}

const CSS = `
  body{margin:0;background:#101114;color:#f2f2f2;font-family:-apple-system,system-ui,sans-serif}
  #tt-root{display:block;max-width:520px;margin:0 auto;padding:20px 16px 40px;box-sizing:border-box;width:100%}
  #tt-root .list{display:flex;flex-direction:column;gap:8px;width:100%}
  #tt-root .num{width:22px;flex:none;color:#9a9ea6;text-align:right;font-size:14px}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#9a9ea6;font-size:13px;margin:0 0 18px;line-height:1.4}
  .row{display:flex;flex-direction:row;gap:6px;align-items:center;width:100%}
  .row input{flex:1;min-width:0;font-size:16px;padding:10px;border-radius:8px;border:1px solid #33363d;background:#1a1c21;color:inherit}
  button{font-size:15px;padding:10px 12px;border-radius:8px;border:1px solid #33363d;background:#23262d;color:inherit;cursor:pointer}
  button:disabled{opacity:.35;cursor:default}
  button.primary{background:#2f6df6;border-color:#2f6df6}
  button.danger{color:#ff8a80}
  .count{color:#9a9ea6;font-size:12px;margin:14px 0 6px}
  .hint{color:#9a9ea6;font-size:12px;margin-top:6px}
  .removed{margin-top:26px;border-top:1px solid #2a2d33;padding-top:12px}
  .removed .row span{flex:1;color:#9a9ea6}
`

function renderEditor() {
  // Render INSIDE the page's own #app (the earlier version showed there), with
  // an inner full-width column wrapper so #app's own layout can't turn the rows sideways.
  let host = document.getElementById('app')
  if (!host) {
    host = h('div', { id: 'app' })
    document.body.append(host)
  }
  let root = document.getElementById('tt-root')
  if (!root) {
    root = h('div', { id: 'tt-root' })
    host.replaceChildren(root)
  }
  if (!document.getElementById('tt-style')) {
    document.head.append(h('style', { id: 'tt-style' }, CSS))
  }

  const act = active()
  const gone = tasks.filter((t) => t.archived)
  const full = act.length >= MAX_TASKS

  const rows = act.map((t, i) => {
    const input = h('input', { value: t.name, maxlength: MAX_NAME, 'aria-label': 'Task name' }) as HTMLInputElement
    input.addEventListener('change', () => {
      const name = cleanName(input.value)
      if (!name) { input.value = t.name; return } // empty = revert
      saveTasks(tasks.map((x) => (x.id === t.id ? { ...x, name } : x)))
    })
    const move = (d: -1 | 1) => () => {
      const order = active()
      const j = i + d
      if (j < 0 || j >= order.length) return
      ;[order[i], order[j]] = [order[j], order[i]]
      saveTasks([...order, ...tasks.filter((x) => x.archived)])
    }
    return h('div', { class: 'row' },
      h('span', { class: 'num' }, `${i + 1}.`),
      input,
      h('button', { disabled: i === 0, onclick: move(-1), 'aria-label': 'Move up' }, '↑'),
      h('button', { disabled: i === act.length - 1, onclick: move(1), 'aria-label': 'Move down' }, '↓'),
      h('button', {
        class: 'danger', 'aria-label': 'Remove',
        onclick: () => saveTasks(tasks.map((x) => (x.id === t.id ? { ...x, archived: true } : x))),
      }, '✕'),
    )
  })

  const addInput = h('input', { placeholder: full ? `Limit of ${MAX_TASKS} reached` : 'New task name', maxlength: MAX_NAME, disabled: full }) as HTMLInputElement
  const add = () => {
    const name = cleanName(addInput.value)
    if (!name || active().length >= MAX_TASKS) return
    const id = Math.max(4, ...tasks.map((x) => x.id)) + 1 // never reuse an id
    saveTasks([...tasks, { id, name }])
  }
  addInput.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') add() })

  const children: (Node | string)[] = [
    h('h1', {}, 'TimeTracker tasks'),
    h('p', { class: 'sub' }, 'Changes show up on the glasses right away. Past time for removed tasks is kept.'),
    h('div', { class: 'count' }, `${act.length} of ${MAX_TASKS} tasks`),
    h('div', { class: 'list' }, ...rows),
    h('div', { class: 'row', style: 'margin-top:12px' }, h('span', { class: 'num' }, '+'), addInput, h('button', { class: 'primary', disabled: full, onclick: add }, 'Add')),
    h('div', { class: 'hint' }, `Names up to ${MAX_NAME} characters so they fit on the display.`),
  ]

  const exitSelect = h('select', {
    'aria-label': 'Double-click on single-task view',
    onchange: (e: Event) => {
      settings = { ...settings, focusExit: (e.target as HTMLSelectElement).value as Settings['focusExit'] }
      writeJSON(K_SETTINGS, settings)
      onTasksChanged() // redraws the current screen, so the on-glasses hint updates
    },
  },
    h('option', { value: 'tasks', selected: settings.focusExit === 'tasks' }, 'Full task screen'),
    h('option', { value: 'reports', selected: settings.focusExit === 'reports' }, 'Reports'),
  )
  children.push(h('div', { class: 'removed' },
    h('div', { class: 'count' }, 'Single-task view'),
    h('div', { class: 'hint', style: 'margin:0 0 8px' }, 'Double-click on the single-task view goes to:'),
    h('div', { class: 'row' }, exitSelect),
  ))

  if (gone.length) {
    children.push(h('div', { class: 'removed' },
      h('div', { class: 'count' }, 'Removed'),
      ...gone.map((t) =>
        h('div', { class: 'row' },
          h('span', {}, t.name),
          h('button', {
            disabled: full,
            onclick: () => saveTasks(tasks.map((x) => (x.id === t.id ? { ...x, archived: false } : x))),
          }, 'Restore'),
        ),
      ),
    ))
  }

  // Replacing the whole tree is fine: edits commit on change, not per key.
  root.replaceChildren(...children)
}

renderEditor()

// Same-origin edits made in another tab/window arrive here.
window.addEventListener('storage', (e) => {
  if (e.key === K_SETTINGS) { settings = loadSettings(); renderEditor(); onTasksChanged(); return }
  if (e.key !== K_TASKS) return
  tasks = loadTasks()
  renderEditor()
  onTasksChanged()
})

const bridge = await waitForEvenAppBridge()

// ---------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------

type Screen = 'tasks' | 'reports' | 'custom' | 'picker' | 'focus'
type Period = 'today' | 'week'
type Pick = { target: 'start' | 'end'; y: number; m: number; d: number; field: number }

let screen: Screen = 'tasks'
let cursor = 0
// The last report view is remembered across screens and app restarts.
const savedView = readJSON<{ last?: string; period?: Period; customStart?: number; customEnd?: number }>(K_VIEW, {})
let period: Period = savedView.period === 'week' ? 'week' : 'today'
let customStart = savedView.customStart ?? startOfWeek(Date.now())
let customEnd = savedView.customEnd ?? startOfDay(Date.now())
let lastView: 'reports' | 'custom' = savedView.last === 'custom' ? 'custom' : 'reports'

function saveView() {
  writeJSON(K_VIEW, { last: lastView, period, customStart, customEnd })
}
let pick: Pick | null = null
let focusId = -1 // task shown in the single-task view
let top = 0 // first visible menu row (scrolling)
let rpage = 0 // report page when there are more than REPORT_ROWS tasks

const MIN_YEAR = new Date().getFullYear() - 3
const MAX_YEAR = new Date().getFullYear() + 1

// ---------------------------------------------------------------------
// Content builders
// ---------------------------------------------------------------------

type Item = { label: string; run: () => void }

const pages = () => Math.max(1, Math.ceil(active().length / REPORT_ROWS))

function pageItem(): Item[] {
  if (pages() <= 1) return []
  return [{
    label: `Tasks pg ${rpage + 1}/${pages()} >`,
    run: () => {
      rpage = (rpage + 1) % pages()
      pushText(screen, 2, 'menu', menuContent)
      refreshReport(false)
    },
  }]
}

// Plain-character marker for the active view (the display has no underline/bold).
const mark = (on: boolean) => (on ? ' *' : '')

// Row of "Reports >" in the Tasks menu (one later while the Focus row shows).
const reportsRow = () => active().length

function openFocus() {
  if (!running) return
  focusId = running.task
  show('focus')
}

const po = () => pageItem().length // 1 when the page item sits on the top line, else 0

function openReports() {
  // With multiple task pages the cursor starts on the "Tasks pg" toggle (top
  // line), so a click flips pages right away; otherwise on the current view.
  if (lastView === 'custom') show('custom', 0)
  else show('reports', po() ? 0 : period === 'week' ? 1 : 0)
}

function menuModel(): Item[] {
  if (screen === 'focus') {
    return [
      {
        label: settings.focusTimer ? 'Hide timer' : 'Show timer',
        run: () => {
          settings = { ...settings, focusTimer: !settings.focusTimer }
          writeJSON(K_SETTINGS, settings)
          pushText('focus', 2, 'menu', menuContent)
          pushText('focus', 3, 'ftimer', focusTimer)
        },
      },
      {
        label: 'Stop timer',
        run: () => {
          const row = active().findIndex((t) => t.id === focusId)
          closeRunning(Date.now())
          show('tasks', Math.max(0, row))
        },
      },
    ]
  }
  if (screen === 'tasks') {
    return [
      ...active().map((t, i) => ({ label: t.name, run: () => { if (running?.task !== t.id) toggleTask(i); focusId = t.id; show('focus') } })),
      { label: 'Reports >', run: () => openReports() },
    ]
  }
  if (screen === 'reports') {
    const choose = (p: Period) => () => {
      period = p
      lastView = 'reports'
      rpage = 0
      saveView()
      pushText('reports', 2, 'menu', menuContent)
      refreshReport(true)
    }
    return [
      ...pageItem(),
      { label: `Today${mark(lastView === 'reports' && period === 'today')}`, run: choose('today') },
      { label: `This week${mark(lastView === 'reports' && period === 'week')}`, run: choose('week') },
      { label: `Custom range${mark(lastView === 'custom')}`, run: () => { lastView = 'custom'; saveView(); show('custom', po()) } },
      { label: '< Back', run: () => show('tasks', reportsRow()) },
      { label: 'Exit app', run: () => { bridge.shutDownPageContainer(1) } }, // asks to confirm; the exit event closes any running timer
    ]
  }
  return [
    ...pageItem(),
    { label: `Start: ${fmtDateY(customStart)}`, run: () => openPicker('start') },
    { label: `End: ${fmtDateY(customEnd)}`, run: () => openPicker('end') },
    { label: '< Back', run: () => show('reports', po() + 2) },
  ]
}

const menuItems = (): string[] => menuModel().map((i) => i.label)

// The first/last visible line becomes a "more tasks" hint when the list
// continues above/below. ASCII on purpose: unsure the display font has arrows.
const UP_MARK = '^ more tasks'
const DOWN_MARK = 'v more tasks'

// How many real items fit when scrolled to `t` (indicator lines take a slot).
function slotsFor(t: number, n: number): number {
  if (n <= MENU_ROWS) return n
  let slots = MENU_ROWS - (t > 0 ? 1 : 0)
  if (t + slots < n) slots -= 1
  return slots
}

// Keep the cursor inside the visible window.
function menuTop(): number {
  const n = menuItems().length
  if (n <= MENU_ROWS) { top = 0; return 0 }
  if (cursor < top) top = cursor
  while (cursor >= top + slotsFor(top, n)) top++
  top = Math.max(0, Math.min(top, n - 1))
  return top
}

// idx = -1 marks an indicator line. Menu and timers both build from this,
// so their lines always match one for one.
function windowRows(): { text: string; idx: number }[] {
  const items = menuItems()
  const n = items.length
  const t = menuTop()
  const slots = slotsFor(t, n)
  const rows: { text: string; idx: number }[] = []
  if (n > MENU_ROWS && t > 0) rows.push({ text: '   ' + UP_MARK, idx: -1 })
  for (let k = 0; k < slots && t + k < n; k++) {
    rows.push({ text: (t + k === cursor ? '> ' : '   ') + items[t + k], idx: t + k })
  }
  if (n > MENU_ROWS && t + slots < n) rows.push({ text: '   ' + DOWN_MARK, idx: -1 })
  return rows
}

function menuContent(): string {
  return windowRows().map((r) => r.text).join('\n')
}

// One line per task, in the same order as the menu lines beside it.
function timersContent(): string {
  const totals = totalsFor(startOfDay(Date.now()), Date.now())
  const act = active()
  return windowRows()
    .map((r) => (r.idx >= 0 && r.idx < act.length ? (running?.task === act[r.idx].id ? '>> ' : '') + fmtClock(totals[r.idx]) : ''))
    .join('\n')
}

// Single-task view: today's total for the focused task.
function focusTimer(): string {
  if (!settings.focusTimer) return ' ' // hidden: leave the timer box blank
  const i = active().findIndex((t) => t.id === focusId)
  const ms = i < 0 ? 0 : totalsFor(startOfDay(Date.now()), Date.now())[i]
  return fmtClock(ms)
}

function currentRange(): { from: number; to: number; label: string } {
  const now = Date.now()
  if (screen === 'custom') {
    return { from: customStart, to: addDays(customEnd, 1) - 1, label: fmtRange(customStart, customEnd) }
  }
  if (period === 'week') {
    const from = startOfWeek(now)
    return { from, to: now, label: `This week - from ${fmtDate(from)}` }
  }
  return { from: startOfDay(now), to: now, label: `Today - ${fmtDate(now)}` }
}

function reportParts(): { title: string; body: string; total: string } {
  const { from, to, label } = currentRange()
  const totals = totalsFor(from, to)
  const sum = totals.reduce((a, b) => a + b, 0)
  return {
    title: label,
    body: (() => {
      rpage = Math.min(rpage, pages() - 1)
      const from = rpage * REPORT_ROWS
      return names().map((t, i) => `${t} - ${fmtShort(totals[i])}`).slice(from, from + REPORT_ROWS).join('\n')
    })(),
    total: `Total Time - ${fmtShort(sum)}`,
  }
}

function pickerContent(): string {
  if (!pick) return ''
  const rows = [`Month: ${MONTHS[pick.m]}`, `Day: ${pick.d}`, `Year: ${pick.y}`]
  return rows.map((r, i) => (i === pick!.field ? '> ' : '   ') + r).join('\n')
}

// ---------------------------------------------------------------------
// Screen builders
// ---------------------------------------------------------------------

type BoxOpts = {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  content: string
  capture?: boolean // only ONE container per screen may capture events
  border?: boolean // bordered box = the "bold" substitute
  dim?: boolean
}

function textBox(o: BoxOpts) {
  return new TextContainerProperty({
    xPosition: o.x, yPosition: o.y, width: o.w, height: o.h,
    borderWidth: o.border ? 2 : 0,
    borderColor: o.border ? 15 : 5,
    paddingLength: 4,
    containerID: o.id, containerName: o.name,
    content: o.content,
    isEventCapture: o.capture ? 1 : 0,
    ...(o.dim && DIM_BODY_TEXT ? { textColor: 2 } : {}),
  })
}

function buildScreen(name: Screen): { containerTotalNum: number; textObject: TextContainerProperty[] } {
  if (name === 'tasks') {
    return {
      containerTotalNum: 3,
      textObject: [
        textBox({ id: 1, name: 'header', x: 0, y: 0, w: 576, h: 36, content: headerText() }),
        textBox({ id: 2, name: 'menu', x: 0, y: 40, w: 340, h: 248, content: menuContent(), capture: true }),
        textBox({ id: 3, name: 'timers', x: 340, y: 40, w: 236, h: 248, content: timersContent() }),
      ],
    }
  }

  if (name === 'focus') {
    // Line 1: task name (left) and its timer (right). Line 2 on: the Hide/Show
    // timer toggle, then Stop timer. No borders.
    return {
      containerTotalNum: 4,
      textObject: [
        textBox({ id: 1, name: 'fname', x: 0, y: 0, w: 340, h: 36, content: tasks.find((t) => t.id === focusId)?.name ?? '' }),
        textBox({ id: 2, name: 'menu', x: 0, y: 40, w: 576, h: 120, content: menuContent(), capture: true }),
        textBox({ id: 3, name: 'ftimer', x: 340, y: 0, w: 236, h: 36, content: focusTimer() }),
        textBox({ id: 4, name: 'fhint', x: 0, y: 250, w: 576, h: 38, content: `Double-click: ${settings.focusExit === 'reports' ? 'Reports' : 'Task List'}` }),
      ],
    }
  }

  if (name === 'picker') {
    return {
      containerTotalNum: 3,
      textObject: [
        textBox({ id: 1, name: 'header', x: 0, y: 0, w: 576, h: 36, content: `Set ${pick?.target ?? 'start'} date` }),
        textBox({ id: 2, name: 'picker', x: 0, y: 40, w: 576, h: 120, content: pickerContent(), capture: true }),
        textBox({
          id: 3, name: 'hint', x: 0, y: 170, w: 576, h: 80,
          content: 'Swipe up/down: change value\nClick: next field, then confirm\nDouble-click: cancel',
        }),
      ],
    }
  }

  // reports + custom share a layout: menu on the left, boxed title / body /
  // boxed total on the right.
  const r = reportParts()
  const bodyH = Math.max(110, Math.min(names().length, REPORT_ROWS) * 27 + 12) // 27px per line + padding
  const totalY = 48 + bodyH + 6
  return {
    containerTotalNum: 5,
    textObject: [
      textBox({ id: 1, name: 'header', x: 0, y: 0, w: 250, h: 36, content: name === 'reports' ? 'Reports' : 'Custom range' }),
      textBox({ id: 2, name: 'menu', x: 0, y: 40, w: 250, h: 248, content: menuContent(), capture: true }),
      textBox({ id: 3, name: 'repTitle', x: 250, y: 0, w: 326, h: 44, content: r.title, border: true }),
      textBox({ id: 4, name: 'repBody', x: 250, y: 48, w: 326, h: bodyH, content: r.body, dim: true }),
      textBox({ id: 5, name: 'repTotal', x: 250, y: totalY, w: 326, h: 44, content: r.total, border: true }),
    ],
  }
}

// ---------------------------------------------------------------------
// Bridge calls — one at a time, and one failure can't block the next
// ---------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve()

function enqueue(fn: () => Promise<unknown>) {
  const task = queue.catch(() => {}).then(fn)
  queue = task.catch((err) => console.error('bridge call failed:', err))
  return task
}

// Text update that is skipped if the user has already left the screen it
// was meant for, and that reads its content when it runs, not when queued.
// Remembers what each container currently shows so identical updates are not
// sent again (every redundant redraw is a chance for visible flicker).
const lastSent = new Map<number, string>()

// While DEBUG_EVENTS is on, the Tasks header also shows the raw type of the
// last input event, so a long press can be identified without any console.
let debugLast = ''
const headerText = () => `TimeTracker - ${fmtDate(Date.now())}${DEBUG_EVENTS && debugLast ? ' | ' + debugLast : ''}`

function pushText(forScreen: Screen, containerID: number, containerName: string, content: () => string) {
  enqueue(async () => {
    if (screen !== forScreen) return
    const c = content()
    if (lastSent.get(containerID) === c) return
    await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID, containerName, content: c }))
    lastSent.set(containerID, c)
  })
}

function show(name: Screen, cursorAt = 0) {
  screen = name
  cursor = cursorAt
  top = 0
  enqueue(async () => {
    if (screen !== name) return // user already moved on; the newer rebuild handles it
    await bridge.rebuildPageContainer(new RebuildPageContainer(buildScreen(name)))
    lastSent.clear() // a rebuild redraws every container from scratch
  })
}

function refreshReport(includeTitle: boolean) {
  if (screen !== 'reports' && screen !== 'custom') return
  const s = screen
  if (includeTitle) pushText(s, 3, 'repTitle', () => reportParts().title)
  pushText(s, 4, 'repBody', () => reportParts().body)
  pushText(s, 5, 'repTotal', () => reportParts().total)
}

// ---------------------------------------------------------------------
// Timer logic — only one task can run at a time
// ---------------------------------------------------------------------

function closeRunning(at: number) {
  if (!running) return
  if (at > running.start) sessions.push({ task: running.task, start: running.start, end: at })
  writeJSON(K_SESSIONS, sessions)
  running = null
  localStorage.removeItem(K_RUNNING)
}

function toggleTask(index: number) {
  const t = active()[index]
  if (!t) return
  const i = t.id
  const now = Date.now()
  const wasThis = running?.task === i
  closeRunning(now) // selecting a task always stops whatever was running
  if (!wasThis) {
    running = { task: i, start: now }
    writeJSON(K_RUNNING, running)
    writeJSON(K_HEARTBEAT, now)
  }
  pushText('tasks', 2, 'menu', menuContent)
  pushText('tasks', 3, 'timers', timersContent)
}

setInterval(() => {
  if (!running) return
  writeJSON(K_HEARTBEAT, Date.now())
  if (screen === 'tasks') pushText('tasks', 3, 'timers', timersContent)
  else if (screen === 'focus') pushText('focus', 3, 'ftimer', focusTimer)
  else refreshReport(false)
}, 1000)

// ---------------------------------------------------------------------
// Date picker — absolute dates, not relative to today
// ---------------------------------------------------------------------

function openPicker(target: 'start' | 'end') {
  const d = new Date(target === 'start' ? customStart : customEnd)
  pick = { target, y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), field: 0 }
  show('picker')
}

function adjustPick(delta: number) {
  if (!pick) return
  if (pick.field === 0) {
    pick.m = (pick.m + delta + 12) % 12
  } else if (pick.field === 1) {
    const dim = daysIn(pick.y, pick.m)
    pick.d = ((pick.d - 1 + delta + dim) % dim) + 1
  } else {
    pick.y = Math.min(MAX_YEAR, Math.max(MIN_YEAR, pick.y + delta))
  }
  pick.d = Math.min(pick.d, daysIn(pick.y, pick.m)) // e.g. Mar 31 -> Feb
  pushText('picker', 2, 'picker', pickerContent)
}

function confirmPick() {
  if (!pick) return
  const ts = new Date(pick.y, pick.m, pick.d).getTime() // local midnight
  if (pick.target === 'start') {
    customStart = ts
    if (customEnd < ts) customEnd = ts // keep the range valid
  } else {
    customEnd = ts
    if (customStart > ts) customStart = ts
  }
  const back = (pick.target === 'start' ? 0 : 1) + po()
  pick = null
  saveView()
  show('custom', back)
}

// ---------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------

// CLICK_EVENT is 0 and protobuf omits zero values, so a tap arrives with
// eventType undefined. Resolve the default only inside an envelope that exists.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function onScroll(dir: -1 | 1) {
  if (screen === 'picker') {
    // dir -1 = swipe up
    adjustPick((dir === -1) === SCROLL_UP_INCREASES ? 1 : -1)
    return
  }
  const n = menuItems().length
  cursor = (cursor + dir + n) % n
  pushText(screen, 2, 'menu', menuContent)
  if (screen === 'tasks') pushText('tasks', 3, 'timers', timersContent)
}

function handleSelect() {
  if (screen !== 'picker') {
    menuModel()[cursor]?.run()
    return
  }
  // picker: click moves Month -> Day -> Year, then confirms
  if (pick && pick.field < 2) {
    pick.field += 1
    pushText('picker', 2, 'picker', pickerContent)
  } else {
    confirmPick()
  }
}

function nextPage() {
  if (pages() <= 1) return
  rpage = (rpage + 1) % pages()
  pushText(screen, 2, 'menu', menuContent)
  refreshReport(false)
}

// Long press:
//  - Tasks: on the running task, open its single-task view.
//  - Reports: on Today / This week / the page line, flip to the next task page.
function handleLongPress() {
  if (screen === 'tasks') {
    const t = active()[cursor]
    if (t && running?.task === t.id) openFocus()
    return
  }
  if (screen === 'reports') {
    const label = menuItems()[cursor] ?? ''
    if (label.startsWith('Today') || label.startsWith('This week') || label.startsWith('Tasks pg')) nextPage()
  }
}

function handleBack() {
  // Double-click on the Tasks screen jumps straight to Reports (exit lives in
  // the Reports menu as "Exit app").
  if (screen === 'tasks') openReports()
  else if (screen === 'reports') show('tasks', reportsRow())
  else if (screen === 'custom') show('reports', po() + 2)
  else if (screen === 'focus') {
    if (settings.focusExit === 'reports') openReports()
    else show('tasks', active().findIndex((t) => t.id === focusId))
  } else {
    const back = (pick?.target === 'end' ? 1 : 0) + po()
    pick = null // cancel: the dates stay as they were
    show('custom', back)
  }
}

// A task was added / renamed / removed / reordered: stop the timer if its task
// is gone, keep the cursor on a valid row, and redraw the current screen.
onTasksChanged = () => {
  if (running && !active().some((t) => t.id === running!.task)) closeRunning(Date.now())
  if (screen === 'focus' && !running) { show('tasks', 0); return }
  if (screen === 'picker') return
  rpage = Math.min(rpage, pages() - 1)
  cursor = Math.min(cursor, menuItems().length - 1)
  show(screen, cursor)
}

const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(buildScreen('tasks')))
if (result !== 0) console.error('createStartUpPageContainer failed:', result)

// Order matters: double-click and scroll carry explicit non-zero types, so
// they are matched before CLICK, which is what an untyped envelope falls
// back to.
bridge.onEvenHubEvent((event) => {
  if (DEBUG_EVENTS) {
    console.log('[tt-event]', Date.now() % 100000, JSON.stringify(event))
    const raw = JSON.stringify((event as any).jsonData ?? event.sysEvent ?? event.textEvent ?? event)
    debugLast = raw.length > 56 ? raw.slice(0, 56) + '...' : raw
    if (screen === 'tasks') pushText('tasks', 1, 'header', headerText)
  }
  let jd: any = (event as any).jsonData
  if (typeof jd === 'string') { try { jd = JSON.parse(jd) } catch { jd = null } }
  if (jd?.eventType === LONG_PRESS_EVENT) {
    handleLongPress()
    return
  }

  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    closeRunning(Date.now()) // don't lose the in-progress session
    return
  }
  if ((sysType as number | null) === LONG_PRESS_EVENT || (textType as number | null) === LONG_PRESS_EVENT) {
    handleLongPress()
    return
  }
  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    handleBack()
    return
  }
  if (textType === OsEventTypeList.SCROLL_TOP_EVENT || sysType === OsEventTypeList.SCROLL_TOP_EVENT) {
    onScroll(-1)
    return
  }
  if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT || sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    onScroll(1)
    return
  }
  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    handleSelect()
  }
})

window.addEventListener('beforeunload', () => closeRunning(Date.now()))
