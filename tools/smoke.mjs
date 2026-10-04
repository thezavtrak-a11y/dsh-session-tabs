/**
 * dsh-session-tabs — smoke test.
 *
 * Loads `lib/client.js` the way the DSH web shell does (a
 * `window.__ModuleLoader__.load({ id, factory })` registration), materializes the
 * factory against a mock module table, applies it to a mock cordis context, and
 * then drives the strip with a miniature React plus a miniature DOM — so the
 * whole feature is exercised headlessly: adopting the current Session, opening
 * from the sidebar, closing, drag reordering, tearing a tab into a new window,
 * the `dshTab` handoff, per-window persistence and the frame reservation.
 *
 * The mock follows the 0.2.0 contract: the Session Controller list is a read-only
 * catalog (`ids`/`byId`/`phase`, no `current`), the Workspace navigation service
 * owns the selection and the New Session policy, and `openSession`/`clearMain`
 * replace that selection synchronously.
 *
 * Run: `node tools/smoke.mjs`
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')
const SOURCE = readFileSync(BUNDLE, 'utf8')

/* ── assertions ──────────────────────────────────────────────────────────── */

let failures = 0
function check(condition, message) {
  if (condition) {
    console.log('  ok   ' + message)
    return
  }
  failures += 1
  console.log('  FAIL ' + message)
}
const equal = (actual, expected, message) =>
  check(Object.is(actual, expected), `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
const joinIds = (hosts) => hosts.map((element) => element.getAttribute('data-tab-id')).join(',')
const tabsOf = (hosts) => hosts.filter((element) => element.getAttribute('data-tab-id') !== null)

/* ── miniature DOM ───────────────────────────────────────────────────────── */

/** One fake element: enough of the DOM for refs, rects and child lookup. */
function makeElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    dataset: {},
    children: [],
    attributes: {},
    style: {
      values: {},
      setProperty(name, value) {
        this.values[name] = value
      },
      removeProperty(name) {
        delete this.values[name]
      },
    },
    parentElement: null,
    getAttribute(name) {
      return name in this.attributes ? this.attributes[name] : null
    },
    hasAttribute(name) {
      return name in this.attributes
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    removeAttribute(name) {
      delete this.attributes[name]
    },
    appendChild(child) {
      this.children.push(child)
      child.parentElement = this
      return child
    },
    contains(node) {
      return node === this
    },
    /* Attribute selectors only — that is all the plugin asks of the DOM. */
    querySelectorAll(selector) {
      const wanted = selector.startsWith('[') ? selector.slice(1, -1) : selector
      const found = []
      const visit = (node) => {
        for (const child of node.children) {
          if (child.getAttribute(wanted) !== null) found.push(child)
          visit(child)
        }
      }
      visit(this)
      return found
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null
    },
    getBoundingClientRect() {
      return this.rect
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    addEventListener() {},
    removeEventListener() {},
    scrollIntoView() {},
    remove() {},
  }
  /* Default geometry: the full-width strip band the frame reserves. */
  element.rect = { left: 0, right: 1200, top: 0, bottom: 36, width: 1200, height: 36 }
  return element
}

/** A storage area backed by a Map. */
function makeStorage() {
  const map = new Map()
  return {
    get length() {
      return map.size
    },
    key(index) {
      return [...map.keys()][index] ?? null
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      map.set(key, String(value))
    },
    removeItem(key) {
      map.delete(key)
    },
  }
}

/**
 * Build one isolated page: window, document, storages and the loader shim.
 *
 * @param options - `href` of the page and an optional `shell` bridge object.
 */
function createPage(options = {}) {
  const frame = makeElement('div')
  const overlay = makeElement('div')
  overlay.setAttribute('data-shell-overlay', '')
  frame.appendChild(overlay)
  const head = makeElement('head')
  const replaced = []

  const document = {
    head,
    body: makeElement('body'),
    createElement: (tag) => makeElement(tag),
    querySelector(selector) {
      if (selector === '[data-shell-overlay]') return overlay
      if (selector.startsWith('style[data-plugin-css=')) {
        return head.children.find((child) => child.dataset.pluginCss !== undefined
          && selector.includes(JSON.stringify(child.dataset.pluginCss))) ?? null
      }
      return null
    },
  }

  const windowStub = {
    __ModuleLoader__: {
      load(registration) {
        windowStub.registration = registration
      },
    },
    document,
    location: { href: options.href ?? 'http://127.0.0.1:61584/?token=test' },
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    history: {
      replaceState(_state, _title, url) {
        replaced.push(url)
        windowStub.location.href = url
      },
    },
    innerWidth: 1440,
    innerHeight: 900,
    outerWidth: 1440,
    outerHeight: 900,
    setTimeout: () => 1,
    clearTimeout() {},
    addEventListener() {},
    removeEventListener() {},
    close() {
      windowStub.closed = true
    },
    open(url) {
      windowStub.opened.push(url)
      return { closed: false }
    },
    registration: undefined,
    opened: [],
    closed: false,
    dshShell: options.shell,
  }

  /* Bare identifiers the bundle uses (document, navigator, crypto, Node, the
   * style and observer APIs) are supplied as parameters so the browser-shaped
   * code runs against the stubs. */
  const factory = new Function(
    'window', 'document', 'crypto', 'Node', 'navigator', 'getComputedStyle', 'MutationObserver',
    SOURCE,
  )
  factory(
    windowStub,
    document,
    globalThis.crypto,
    class Node {},
    options.navigator ?? {},
    options.getComputedStyle ?? (() => ({ backgroundColor: 'rgb(21, 23, 27)', color: 'rgb(154, 160, 166)' })),
    options.MutationObserver ?? class MutationObserver {
      observe() {}
      disconnect() {}
    },
  )

  return { window: windowStub, document, frame, overlay, replaced, head }
}

/* ── miniature React ─────────────────────────────────────────────────────── */

/** Hook cells per component function, persisted across renders like React's. */
const instances = new Map()
function instanceOf(type) {
  let instance = instances.get(type)
  if (instance === undefined) {
    instance = { state: [], refs: [], index: 0 }
    instances.set(type, instance)
  }
  return instance
}

let stack = []
function current() {
  const frame = stack[stack.length - 1]
  if (frame === undefined) throw new Error('hook called outside a render')
  return frame
}

const React = {
  createElement(type, props, ...children) {
    const flat = []
    const push = (child) => {
      if (Array.isArray(child)) {
        child.forEach(push)
        return
      }
      if (child === null || child === undefined || typeof child === 'boolean') return
      flat.push(child)
    }
    children.forEach(push)
    const next = { ...(props ?? {}) }
    if (flat.length === 1) next.children = flat[0]
    else if (flat.length > 1) next.children = flat
    return { __el: true, type, props: next }
  },
  useState(initial) {
    const frame = current()
    const index = frame.instance.index++
    if (!(index in frame.instance.state)) {
      frame.instance.state[index] = typeof initial === 'function' ? initial() : initial
    }
    const set = (value) => {
      frame.instance.state[index] = typeof value === 'function' ? value(frame.instance.state[index]) : value
    }
    return [frame.instance.state[index], set]
  },
  useRef(initial) {
    const frame = current()
    const index = frame.instance.index++
    if (!(index in frame.instance.refs)) frame.instance.refs[index] = { current: initial }
    return frame.instance.refs[index]
  },
  useCallback(fn) {
    current().instance.index += 1
    return fn
  },
  useMemo(factory) {
    current().instance.index += 1
    return factory()
  },
  /** Effects run inline: there is no browser scheduler here. */
  useEffect(fn) {
    current().instance.index += 1
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : undefined
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    current().instance.index += 1
    return getSnapshot()
  },
}

/**
 * Render one element tree into fake DOM nodes, resolving function components
 * and attaching `ref` objects the way React would.
 *
 * @returns every host element rendered, in document order.
 */
function render(node, parent) {
  const hosts = []
  const visit = (item, parentNode) => {
    if (item === null || item === undefined || typeof item === 'boolean') return
    if (typeof item === 'string' || typeof item === 'number') return
    if (Array.isArray(item)) {
      item.forEach((child) => visit(child, parentNode))
      return
    }
    if (item.__el !== true) return
    if (typeof item.type === 'function') {
      const instance = instanceOf(item.type)
      instance.index = 0
      stack.push({ instance })
      let produced
      try {
        produced = item.type(item.props)
      } finally {
        stack.pop()
      }
      visit(produced, parentNode)
      return
    }
    const element = parentNode.appendChild(makeElement(item.type))
    element.props = item.props
    for (const [name, value] of Object.entries(item.props ?? {})) {
      if (name.startsWith('data-') && value !== undefined && value !== null) element.setAttribute(name, String(value))
    }
    if (item.props?.ref !== undefined && typeof item.props.ref === 'object') item.props.ref.current = element
    hosts.push(element)
    visit(item.props?.children, element)
  }
  visit(node, parent)
  return hosts
}

/* ── mock cordis context and Session Controller ──────────────────────────── */

/**
 * Mount the bundle onto a mock context.
 *
 * @param page - the page built by {@link createPage}.
 * @param options - the initial Session list, the selected global panel, and the
 *   fake standard hooks the shell would inject.
 */
function mount(page, options) {
  const registration = page.window.registration
  const mod = registration.factory((spec) => {
    if (spec === 'react') return React
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
      /* The module table may or may not carry the icon set: both paths matter. */
      if (options.primitives === undefined) throw new Error('unexpected require(' + spec + ')')
      return options.primitives
    }
    throw new Error('unexpected require(' + spec + ')')
  })
  const dicts = {}
  const slots = []
  const calls = { open: [], clear: 0, panel: [], created: [], startSession: [] }
  /* The fixture carries the Session that should be current; the live contract keeps
   * that in the Workspace navigation selection, so the mock moves it out of the list
   * snapshot — the component must never read a `current` field off the list. */
  const fixture = options.list ?? { ids: [], byId: {}, phase: 'ready' }
  const fixtureCurrent = fixture.current
  const listSnapshot = { ids: fixture.ids, byId: fixture.byId, phase: fixture.phase }
  const selectionListeners = new Set()
  const state = {
    list: listSnapshot,
    selection: fixtureCurrent === undefined ? {} : { sessionId: fixtureCurrent },
    panelId: options.panelId ?? null,
    /* Workspace rows are absent unless a test asks for them. */
    workspaces: options.workspaces === undefined
      ? null
      : { archivedSessionIds: [], phase: 'ready', ...options.workspaces },
  }
  /* Publish a selection change the way the real store does: replacing the snapshot
   * and notifying subscribers. Effects run inline here, so tests see it at once. */
  const setSelection = (id) => {
    state.selection = id === undefined ? {} : { sessionId: id }
    for (const listener of [...selectionListeners]) listener()
  }

  const ctx = {
    logger: {
      warn: (...args) => console.log('    warn:', ...args),
      error: (...args) => console.log('    error:', ...args),
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(ns, ...rest) {
        dicts[ns] = rest.length === 1 ? rest[0] : { [rest[0]]: rest[1] }
        return () => {}
      },
      bind(ns) {
        return (key) => {
          const dict = dicts[ns] ?? {}
          return dict.ru?.[key] ?? dict.en?.[key] ?? key
        }
      },
    },
    slots: {
      inject(name, fn) {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(definition, component) {
        slots.push({ definition, component })
        return () => {}
      },
    },
    /* 0.2.0: the Session Controller list is read-only for the strip — selection and
     * navigation belong to the Workspace navigation service. */
    sessions: {
      list: { getSnapshot: () => state.list },
    },
    uiWorkspace: {
      selection: {
        getSnapshot: () => state.selection,
        subscribe(listener) {
          selectionListeners.add(listener)
          return () => selectionListeners.delete(listener)
        },
      },
      openSession(id) {
        calls.open.push(id)
        setSelection(id)
      },
      /** The service owns the reuse-or-create policy; a test scripts its outcome. */
      startSession(workspaceId) {
        calls.startSession.push(workspaceId ?? null)
        if (typeof options.onStartSession === 'function') {
          options.onStartSession({
            open: (id) => this.openSession(id),
            clear: () => this.clearMain(),
            create(id, title) {
              calls.created.push({ workspaceId: workspaceId ?? null })
              state.list = {
                ...state.list,
                ids: [...state.list.ids, id],
                byId: { ...state.list.byId, [id]: session(id, title ?? 'Новая', { blank: true }) },
              }
              return id
            },
          })
        }
      },
      clearMain() {
        calls.clear += 1
        setSelection(undefined)
      },
    },
    get workspaces() {
      if (state.workspaces === null) throw new Error('workspaces service is not provided')
      return { list: { getSnapshot: () => state.workspaces } }
    },
    layout: {
      selectPanel(id) {
        calls.panel.push(id)
        state.panelId = id
      },
    },
  }

  mod.apply(ctx)

  const props = {
    useSessions: (selector) => (selector === undefined ? state.list : selector(state.list)),
    usePanelInfo: (selector) => (selector === undefined
      ? { activePanelId: state.panelId }
      : selector({ activePanelId: state.panelId })),
  }

  return {
    mod,
    registration,
    slots,
    ctx,
    calls,
    dicts,
    props,
    state,
    /** Replace the list the way a host push would, and select one Session. */
    setList(rows, current) {
      const snapshot = listOf(rows, current)
      state.list = { ids: snapshot.ids, byId: snapshot.byId, phase: snapshot.phase }
      if (current !== undefined) setSelection(current)
    },
    draw() {
      /* Two passes: the first runs the effects (which is where a Session is
       * adopted), the second renders what those effects published — exactly the
       * render the real store notification would trigger. */
      const element = () => React.createElement(slots[0].component, props)
      render(element(), page.overlay)
      return render(element(), page.overlay)
    },
  }
}

/** Build one Session-list snapshot. */
function listOf(rows, current) {
  const byId = {}
  for (const row of rows) byId[row.id] = row
  return { ids: rows.map((row) => row.id), byId, current, phase: 'ready' }
}

const session = (id, title, extra = {}) => ({ id, displayTitle: title, blank: false, running: false, updatedAt: 1, ...extra })

/** Point a fake element and its parent band at a strip-like geometry. */
function layoutStrip(tab) {
  const strip = tab.parentElement
  const bar = strip.parentElement
  bar.rect = { left: 0, right: 1200, top: 0, bottom: 36, width: 1200, height: 36 }
  strip.children.forEach((child, index) => {
    child.rect = { left: index * 100, right: index * 100 + 100, top: 0, bottom: 36, width: 100, height: 36 }
  })
  return { strip, bar }
}

const down = (element, pointerId, x = 40, y = 18) =>
  element.props.onPointerDown({ button: 0, pointerId, clientX: x, clientY: y, target: null, currentTarget: element })
const move = (element, pointerId, x, y) =>
  element.props.onPointerMove({ pointerId, clientX: x, clientY: y })
const up = (element, pointerId, x, y, screenX = x, screenY = y) =>
  element.props.onPointerUp({ pointerId, clientX: x, clientY: y, screenX, screenY })
const flush = () => new Promise((resolve) => setImmediate(resolve))

/* ── the test run ────────────────────────────────────────────────────────── */

console.log('dsh-session-tabs smoke')
const ROWS = [session('s1', 'Первая'), session('s2', 'Вторая'), session('s3', 'Третья')]

/* 1. Registration and mounting. */
{
  const page = createPage()
  const mounted = mount(page, { list: listOf(ROWS, 's2') })
  check(mounted.registration.id === 'dsh-session-tabs', 'bundle registers under the package name')
  equal(mounted.mod.name, 'dsh-session-tabs', 'exports a stable plugin name')
  check(typeof mounted.mod.apply === 'function', 'exports apply()')
  check(Array.isArray(mounted.mod.inject) && mounted.mod.inject.includes('slots'), 'inject roster carries slots')
  equal(mounted.slots.length, 1, 'exactly one slot registration')
  equal(mounted.slots[0].definition.name, 'shell.overlay', 'registers into the shell.overlay seat')
  equal(mounted.slots[0].definition.id, 'session-tabs', 'registration id is stable')
  check(page.head.children.some((child) => child.dataset.pluginCss === 'dsh-session-tabs/tabs.css'), 'stylesheet injected')
  check(mounted.dicts.sessionTabs.ru !== undefined && mounted.dicts.sessionTabs.en !== undefined, 'ru and en dictionaries registered')
}

/* 2. The current Session becomes the first tab. */
{
  const page = createPage()
  const mounted = mount(page, { list: listOf(ROWS, 's2') })
  const hosts = mounted.draw()
  const tabs = tabsOf(hosts)
  equal(tabs.length, 1, 'one tab after the first render')
  equal(tabs[0].getAttribute('data-tab-id'), 's2', 'the current Session owns the tab')
  equal(tabs[0].getAttribute('data-active'), '', 'the tab is marked active')
  const title = hosts.find((element) => element.props?.className === 'dsh-tabs__title')
  equal(title.props.children, 'Вторая', 'the tab shows the durable title')
  const strip = hosts.find((element) => element.props?.className === 'dsh-tabs__strip')
  const bar = hosts.find((element) => element.props?.className === 'dsh-tabs')
  equal(strip.props.role, 'tablist', 'the tablist role lives on the strip, not the row')
  equal(bar.props.role, undefined, 'and the row itself has no tablist role (it holds a button)')
  check(page.frame.hasAttribute('data-dsh-session-tabs'), 'the frame reserves the strip band')
  equal(page.frame.style.values['--dsh-session-tabs-h'], '36px', 'the reserved height is published as a variable')
}

/* 3. A Session that becomes current elsewhere opens a second tab; closing keeps the rest. */
{
  const page = createPage()
  const mounted = mount(page, { list: listOf(ROWS, 's1') })
  equal(tabsOf(mounted.draw()).length, 1, 'first tab from the current Session')
  mounted.setList(ROWS, 's2')
  const hosts = mounted.draw()
  let tabs = tabsOf(hosts)
  equal(joinIds(tabs), 's1,s2', 'a sidebar click opened a second tab')
  equal(mounted.calls.open.length, 0, 'adopting the current Session does not re-open it')

  const close = tabs[0].children.find((child) => child.props?.className === 'dsh-tabs__close')
  check(close !== undefined, 'the close button is rendered')
  close.props.onClick({ stopPropagation() {} })
  const after = mounted.draw()
  tabs = tabsOf(after)
  equal(joinIds(tabs), 's2', 'closing a tab leaves the others')
  equal(tabs[0].getAttribute('data-active'), '', 'the surviving tab is active')
  equal(mounted.calls.clear, 0, 'closing a non-last tab never clears the selection')
}

/* 4. Clicking a tab opens it through the Session Controller and leaves a global panel. */
{
  const page = createPage()
  const mounted = mount(page, { list: listOf(ROWS, 's1'), panelId: 'cost' })
  mounted.draw()
  mounted.setList(ROWS, 's2')
  const hosts = mounted.draw()
  const first = tabsOf(hosts)[0]
  down(first, 1, 10, 10)
  up(first, 1, 12, 11)
  equal(mounted.calls.open.at(-1), 's1', 'clicking a tab opens that Session')
  equal(mounted.calls.panel.at(-1), null, 'clicking a tab returns from a global panel to the conversation')
}

/* 5. Middle click closes a tab. */
{
  const page = createPage()
  const mounted = mount(page, { list: listOf(ROWS, 's1') })
  mounted.draw()
  mounted.setList(ROWS, 's2')
  const tabs = tabsOf(mounted.draw())
  let prevented = false
  tabs[1].props.onAuxClick({ button: 1, preventDefault: () => { prevented = true } })
  check(prevented, 'the middle click is consumed')
  equal(joinIds(tabsOf(mounted.draw())), 's1', 'middle click closed the tab')
  equal(mounted.calls.open.at(-1), 's1', 'the neighbour was opened')
}

/* 6. Dragging the active tab out of the strip asks the shell for a window, hands
 *    the Session over, and moves the window on to the neighbour. */
{
  const shellCalls = []
  const page = createPage({ shell: { openSessionWindow: (options) => { shellCalls.push(options); return true } } })
  const mounted = mount(page, { list: listOf(ROWS, 's1') })
  mounted.draw()
  mounted.setList(ROWS, 's2')
  const target = tabsOf(mounted.draw())[1]
  layoutStrip(target)
  down(target, 7)
  move(target, 7, 60, 400)
  up(target, 7, 60, 400, 500, 420)
  await flush()

  equal(shellCalls.length, 1, 'the shell was asked for exactly one window')
  check(shellCalls[0].href.includes('dshTab=s2'), 'the new window is handed the torn-off Session')
  equal(shellCalls[0].x, 380, 'the window lands at the drop point (x)')
  equal(shellCalls[0].y, 406, 'the window lands at the drop point (y)')
  const remaining = tabsOf(mounted.draw())
  equal(joinIds(remaining), 's1', 'the detached tab left the source window')
  equal(remaining[0].getAttribute('data-active'), '', 'and the neighbour became the active tab')
  equal(mounted.calls.open.at(-1), 's1', 'the neighbour was opened through the controller')
}

/* 7. A window opened in a plain browser uses window.open instead of the shell verb. */
{
  const page = createPage()
  const mounted = mount(page, { list: listOf(ROWS, 's1') })
  mounted.draw()
  mounted.setList(ROWS, 's2')
  const target = tabsOf(mounted.draw())[0]
  layoutStrip(target)
  down(target, 5)
  move(target, 5, 60, 500)
  up(target, 5, 60, 500, 300, 320)
  await flush()
  equal(page.window.opened.length, 1, 'window.open was used')
  check(page.window.opened[0].includes('dshTab=s1'), 'the popup address carries the handoff')
}

/* 8. A refused new window keeps the tab. */
{
  const page = createPage({ shell: { openSessionWindow: () => false } })
  const mounted = mount(page, { list: listOf(ROWS, 's1') })
  mounted.draw()
  mounted.setList(ROWS, 's2')
  const target = tabsOf(mounted.draw())[0]
  layoutStrip(target)
  down(target, 3)
  move(target, 3, 60, 500)
  up(target, 3, 60, 500, 60, 520)
  await flush()
  equal(joinIds(tabsOf(mounted.draw())), 's1,s2', 'a refused detach keeps both tabs')
}

/* 9. Drag reordering rewrites the order, and the order is persisted. */
{
  const page = createPage()
  const mounted = mount(page, { list: listOf(ROWS, 's1') })
  mounted.draw()
  mounted.setList(ROWS, 's2')
  mounted.draw()
  mounted.setList(ROWS, 's3')
  let tabs = tabsOf(mounted.draw())
  equal(joinIds(tabs), 's1,s2,s3', 'tabs keep their opening order')

  const dragged = tabs[2]
  layoutStrip(dragged)
  down(dragged, 9, 250, 18)
  move(dragged, 9, 10, 20)
  up(dragged, 9, 10, 20)
  tabs = tabsOf(mounted.draw())
  equal(joinIds(tabs), 's3,s1,s2', 'the dragged tab moved to the pointer slot')
  const windowId = page.window.sessionStorage.getItem('dsh.session-tabs.window')
  const stored = JSON.parse(page.window.localStorage.getItem('dsh.session-tabs.v1:' + windowId))
  equal(stored.tabs.join(','), 's3,s1,s2', 'the order is persisted for this window')
}

/* 10. Sessions that left the host list lose their tabs. */
{
  const page = createPage()
  const mounted = mount(page, { list: listOf(ROWS, 's1') })
  mounted.draw()
  mounted.setList(ROWS, 's2')
  mounted.draw()
  equal(joinIds(tabsOf(mounted.draw())), 's1,s2', 'two tabs before the deletion')
  mounted.setList([session('s2', 'Вторая')], 's2')
  equal(joinIds(tabsOf(mounted.draw())), 's2', 'the deleted Session lost its tab')
}

/* 11. The dshTab handoff: a detached window starts with exactly that tab, active. */
{
  const page = createPage({ href: 'http://127.0.0.1:61584/?token=test&dshTab=s9' })
  const rows = [session('s9', 'Отцепленная'), session('s1', 'Первая')]
  const mounted = mount(page, { list: listOf(rows, 's1') })
  equal(page.replaced.length, 1, 'the handoff parameter is stripped from the address bar')
  check(!page.replaced[0].includes('dshTab'), 'the cleaned address keeps the rest of the query')
  const tabs = tabsOf(mounted.draw())
  equal(tabs.length, 1, 'the detached window shows one tab')
  equal(tabs[0].getAttribute('data-tab-id'), 's9', 'and it is the handed-over Session')
  equal(mounted.calls.open.at(-1), 's9', 'the window re-opens its own Session')
  equal(page.window.sessionStorage.getItem('dsh.session-tabs.detached'), '1', 'the window remembers it was torn off')
}

/* 12. Closing the last tab of a torn-off window closes the window. */
{
  const page = createPage({ href: 'http://127.0.0.1:61584/?token=test&dshTab=s9' })
  const rows = [session('s9', 'Отцепленная')]
  const mounted = mount(page, { list: listOf(rows, 's9') })
  const tabs = tabsOf(mounted.draw())
  const close = tabs[0].children.find((child) => child.props?.className === 'dsh-tabs__close')
  close.props.onClick({ stopPropagation() {} })
  check(page.window.closed, 'the emptied torn-off window closes itself')
  equal(mounted.calls.clear, 0, 'and never clears the shared selection')
}

/* 13. Unloading the plugin releases the frame reservation. */
{
  const page = createPage()
  const disposes = []
  let component = null
  const registration = page.window.registration
  const mod = registration.factory((spec) => {
    if (spec === 'react') return React
    throw new Error('unexpected require(' + spec + ')')
  })
  const ctx = {
    logger: { warn() {}, error() {} },
    effect(fn) {
      const dispose = fn()
      disposes.push(typeof dispose === 'function' ? dispose : () => {})
      return () => {}
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (_name, fn) => {
        fn()
        return () => {}
      },
      register: (_definition, registered) => {
        component = registered
        return () => {}
      },
    },
    sessions: { list: { getSnapshot: () => listOf(ROWS, 's1') } },
    uiWorkspace: {
      selection: { getSnapshot: () => ({ sessionId: 's1' }), subscribe: () => () => {} },
      openSession() {},
      startSession() {},
      clearMain() {},
    },
    layout: { selectPanel() {} },
  }
  mod.apply(ctx)
  const list = listOf(ROWS, 's1')
  render(React.createElement(component, {
    useSessions: (selector) => selector(list),
    usePanelInfo: (selector) => selector({ activePanelId: null }),
  }), page.overlay)
  check(page.frame.hasAttribute('data-dsh-session-tabs'), 'the mounted strip marks the frame')
  for (const dispose of disposes) dispose()
  check(!page.frame.hasAttribute('data-dsh-session-tabs'), 'unload removes the reservation')
}

/* 14. Caption-row mode: the strip becomes the title bar, opening with a square
 *     New Session button, keeping the native buttons' column clear, reserving
 *     the free space after the tabs for dragging, and painting the caption
 *     colours from the theme. */
{
  const overlayCalls = []
  const page = createPage({
    shell: { setTitleBarOverlay: (options) => overlayCalls.push(options) },
    navigator: {
      windowControlsOverlay: {
        visible: true,
        addEventListener() {},
        removeEventListener() {},
        /* Windows reserves the right end of the caption band: 1440 - 1302 = 138px. */
        getTitlebarAreaRect: () => ({ x: 0, y: 0, width: 1302, height: 36 }),
      },
    },
  })
  const mounted = mount(page, { list: listOf(ROWS, 's1') })
  const hosts = mounted.draw()
  const bar = hosts.find((element) => element.props?.className === 'dsh-tabs')
  const button = hosts.find((element) => element.props?.className === 'dsh-tabs__new')
  const fill = hosts.find((element) => element.props?.className === 'dsh-tabs__fill')
  equal(bar.getAttribute('data-titlebar'), '', 'the bar knows it is the caption row')
  check(button !== undefined, 'the New Session square opens the row')
  check(fill !== undefined, 'the free space after the tabs is its own drag region')
  /* The band is shared with the app's own controls: a bar that took clicks across its
   * whole width made the sidebar toggle under it dead. */
  const css = page.head.children.map((child) => child.textContent ?? '').join('')
  check(/\.dsh-tabs\{[^}]*pointer-events:none/.test(css), 'the band itself takes no clicks')
  check(/\.dsh-tabs__new,[^{]*\{pointer-events:auto\}/.test(css), 'its own controls opt back in')
  check(/\.dsh-tabs__fill\{[^}]*pointer-events:none/.test(css), 'and the drag area stays transparent to clicks')
  equal(bar.props.style.paddingRight, '146px', 'the native buttons keep their column clear')
  equal(bar.props.style.paddingLeft, '6px', 'the caption row keeps a small gap at the left edge')
  equal(button.props.style.width, '24px', 'the button is square')
  equal(button.props.style.height, '24px', 'and as tall as it is wide')
  equal(
    parseInt(bar.props.style.paddingLeft, 10)
      + parseInt(button.props.style.width, 10)
      + parseInt(button.props.style.marginRight, 10),
    36,
    'the empty part left of the tabs is still as wide as the row is tall',
  )
  equal(button.props.title, 'Новая сессия', 'the button is labelled')
  equal(page.frame.style.values['--dsh-session-tabs-h'], '36px', 'the frame reserves the caption band')
  equal(overlayCalls.length >= 1, true, 'the shell was told the caption colours')
  equal(overlayCalls[0].color, '#15171b', 'colour comes from the painted strip')
  equal(overlayCalls[0].symbolColor, '#9aa0a6', 'symbol colour comes from the strip text colour')
  equal(overlayCalls[0].height, 36, 'the overlay is as tall as the strip')
}

/* 15. The caption band's height drives the square, the reservation and the frame. */
{
  const page = createPage({
    navigator: {
      windowControlsOverlay: {
        visible: true,
        addEventListener() {},
        removeEventListener() {},
        getTitlebarAreaRect: () => ({ x: 0, y: 0, width: 1302, height: 42 }),
      },
    },
  })
  const mounted = mount(page, { list: listOf(ROWS, 's1') })
  const hosts = mounted.draw()
  const button = hosts.find((element) => element.props?.className === 'dsh-tabs__new')
  equal(page.frame.style.values['--dsh-session-tabs-h'], '42px', 'the strip follows the reported caption height')
  equal(button.props.style.width, '30px', 'and the New Session square grows with it')
}

/* 16. Without the overlay (a plain browser, or a shell with its own title bar)
 *     the strip stays an ordinary in-page bar — with the same button, but no
 *     caption geometry and no drag region. */
{
  const overlayCalls = []
  const page = createPage({ shell: { setTitleBarOverlay: (options) => overlayCalls.push(options) } })
  const mounted = mount(page, { list: listOf(ROWS, 's1') })
  const hosts = mounted.draw()
  const bar = hosts.find((element) => element.props?.className === 'dsh-tabs')
  const button = hosts.find((element) => element.props?.className === 'dsh-tabs__new')
  equal(bar.getAttribute('data-titlebar'), null, 'no caption-row behaviour without the overlay')
  equal(hosts.some((element) => element.props?.className === 'dsh-tabs__fill'), false, 'and no drag region')
  check(button !== undefined, 'but the New Session square is still there')
  equal(bar.props.style, undefined, 'and the bar keeps its stylesheet padding')
  equal(overlayCalls.length, 0, 'and no caption colours are sent')
}

/* 17. The New Session square delegates to the Workspace navigation service (which
 *     owns the reuse-or-create policy) and adopts the Session it selects. */
{
  const blank = session('s0', 'Новая', { blank: true, cwd: '/proj' })
  const rows = [session('s1', 'Текущая', { cwd: '/proj' }), blank]
  const page = createPage()
  const mounted = mount(page, {
    list: listOf(rows, 's1'),
    workspaces: { items: [{ workspaceId: 'w1', path: '/proj', sessionIds: ['s1', 's0'], createdAt: '2026-01-01T00:00:00Z' }] },
    /* The service reuses the workspace's blank Session, exactly as the live one does. */
    onStartSession: (navigation) => navigation.open('s0'),
  })
  const button = mounted.draw().find((element) => element.props?.className === 'dsh-tabs__new')
  button.props.onClick()
  await flush()
  equal(mounted.calls.startSession.length, 1, 'the square asked the navigation service to start a Session')
  equal(mounted.calls.created.length, 0, 'and created nothing itself')
  equal(mounted.calls.open.at(-1), 's0', 'the Session the service selected is opened')
  equal(joinIds(tabsOf(mounted.draw())), 's1,s0', 'and it became a tab')
}

/* 18. A start that creates a Session shows up as a tab too. */
{
  const rows = [session('s1', 'Текущая', { cwd: '/proj' })]
  const page = createPage()
  const mounted = mount(page, {
    list: listOf(rows, 's1'),
    onStartSession: (navigation) => navigation.open(navigation.create('s-new', 'Новая')),
  })
  const button = mounted.draw().find((element) => element.props?.className === 'dsh-tabs__new')
  button.props.onClick()
  await flush()
  equal(mounted.calls.created.length, 1, 'the service created one Session')
  equal(mounted.calls.open.at(-1), 's-new', 'and the strip followed the selection')
  equal(joinIds(tabsOf(mounted.draw())), 's1,s-new', 'the created Session became a tab')
}

/* 19. A start that clears the selection empties the strip into the New Session view. */
{
  const page = createPage()
  const mounted = mount(page, {
    list: listOf(ROWS, 's1'),
    onStartSession: (navigation) => navigation.clear(),
  })
  const button = mounted.draw().find((element) => element.props?.className === 'dsh-tabs__new')
  button.props.onClick()
  await flush()
  equal(mounted.calls.clear, 1, 'the selection was cleared into the New Session view')
  equal(mounted.calls.created.length, 0, 'and nothing was created')
  const left = tabsOf(mounted.draw())
  equal(joinIds(left), 's1', 'the tab survives: clearing the selection is not closing it')
  equal(left[0].getAttribute('data-active'), null, 'but no tab is active any more')
}

/* 20. The button renders the shell's icon when the module table has it, and a
 *     drawn plus when it does not. */
{
  const iconSet = {
    IconNewChatOutline16: () => React.createElement('svg', { 'data-icon': 'new-chat' }),
  }
  const withIcons = createPage()
  const mountedWithIcons = mount(withIcons, { list: listOf(ROWS, 's1'), primitives: iconSet })
  const buttonWithIcons = mountedWithIcons.draw().find((element) => element.props?.className === 'dsh-tabs__new')
  equal(buttonWithIcons.children[0].getAttribute('data-icon'), 'new-chat', "the shell's own icon is used when present")

  const withoutIcons = createPage()
  const mountedWithout = mount(withoutIcons, { list: listOf(ROWS, 's1') })
  const buttonWithout = mountedWithout.draw().find((element) => element.props?.className === 'dsh-tabs__new')
  equal(buttonWithout.children[0].tagName, 'SVG', 'and a drawn plus stands in when it is missing')
}

/* 21. Two rapid clicks start only one Session (the ref guard beats setState lag). */
{
  const rows = [session('s1', 'Текущая', { cwd: '/proj' })]
  const page = createPage()
  const mounted = mount(page, {
    list: listOf(rows, 's1'),
    onStartSession: (navigation) => navigation.open(navigation.create('s-new', 'Новая')),
  })
  const button = mounted.draw().find((element) => element.props?.className === 'dsh-tabs__new')
  button.props.onClick()
  button.props.onClick()
  await flush()
  equal(mounted.calls.startSession.length, 1, 'a double click still starts exactly one Session')
  equal(mounted.calls.created.length, 1, 'and the service created exactly one')
}

console.log(failures === 0 ? 'RESULT: all checks passed' : `RESULT: ${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
