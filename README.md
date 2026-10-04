# dsh-session-tabs

Browser-style tabs for the Sessions a DeepSeek Harness window has open — switch, close, reorder by
drag, and tear a tab off into a window of its own, as a
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) client plugin.

Every Session the window has touched becomes a tab in a strip above the whole app. Click a tab to
switch to it, close it with `×` / middle click / the context menu, drag it left or right to reorder,
or drag it out of the strip to hand it to a new window. Closing a tab never deletes a Session —
exactly like closing a browser tab never deletes a page.

Nothing upstream is patched. The plugin registers into the official slot, locale and Session faces of
the web client, so it survives DSH upgrades and uninstalls by removing one row.

## What you get

- **Tabs for open Sessions** — one tab per Session this window shows, in the order you left them in.
- **Switch** — click a tab. If a global panel is open, the click returns to the conversation first.
- **Close** — `×` on the tab, the middle mouse button, or the context menu (`Close tab`, `Close other
  tabs`, `Close all tabs`). The Session itself stays in the sidebar and reopens with one click.
- **Reorder** — drag a tab left or right; the neighbours part as you go and the new order is written
  to this window's tab list.
- **Tear off into its own window** — drag a tab out of the strip and release: a hint appears under
  the cursor while the pointer is outside, and the Session opens in a new window. The context menu's
  `Open in a new window` does the same without dragging.
- **Restore** — the tab list of a window survives a page reload. A Session deleted in the sidebar
  loses its tab, and tab lists belonging to windows that are gone are dropped after 14 days instead
  of piling up in storage.
- **State dots** — a pulsing dot means that Session is working; a green one means it finished and has
  not been opened since.
- **Wheel scrolling** — the wheel over the strip scrolls it sideways when the tabs overflow.
- **Keyboard** — `Enter` / `Space` on a tab opens it, `Delete` / `Backspace` closes it; the strip is
  a `tablist` and the tabs are `tab`s.
- **New Session square** — the `+` at the left of the strip starts a Session through the client's own
  navigation service, so the reuse-or-create policy stays where it belongs.
- **Caption-row mode** — when the shell hands the page the window's title bar, the strip moves into
  the caption row itself and sits flush with the top of the window: the native Windows buttons stay
  native (Snap Layouts keep working) and their colours follow the live theme. Without that handover
  the strip is an ordinary band inside the page.
- **A strip that does not get in the way** — it starts to the right of the app's own leading
  controls and of the native window menu, and it is transparent to clicks except on its own controls,
  so the sidebar-collapse button underneath still works.

## Install

The package declares `dsh.client` (browser half) and `dsh.bundle.patch` (loader row), so it installs
like any other DSH plugin:

```sh
# from a checkout, or from a published copy
dsh plugin --profile <profile> add <checkout>
# after that, reload the page once (a NEW row is picked up when the page's module table is built)
```

Manual mounting into a profile, which is what this repository was developed against:

```powershell
# 1. live link so edits are picked up by client HMR without reinstalling
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-session-tabs" `
         -Target (Resolve-Path .).Path

# 2. dependency of the profile:  $DSH_HOME/profiles/<profile>/package.json
#    "dsh-session-tabs": "file:<path to this checkout>"

# 3. loader row:  $DSH_HOME/profiles/<profile>/cordis.patch.yml
#    - insert:
#        - id: session-tabs
#          name: dsh-session-tabs
```

The row belongs in the profile's patch layer rather than in `dsh.profile.bundles`, because the patch
layer reloads live: an edit to `lib/client.js` is picked up by client HMR without a restart, and a
page reload picks up everything else. A patch file must not be empty — use `[]` to disable the layer.

Rollback = drop the insert row, then reload the page; the dependency and the junction can stay, since
without the row the package is simply not mounted.

## How it works

| File | Role |
|---|---|
| `index.js` | Host half: an empty `apply()`, there only so the loader can mount the package and the client-modules scanner can find the `dsh.client` declaration |
| `lib/client.js` | The whole feature: the strip, the per-window tab store, the gestures, the caption-row handling, the tear-off hand-off |
| `cordis.patch.yml` | The loader row a bundle install applies |

Five decisions worth keeping when editing:

1. **The strip is one entry in the shell's `shell.overlay` seat.** That seat is a click-through
   absolute layer above every column, so the strip can sit above the whole app. The frame itself is
   shifted down by the strip's height through a CSS rule keyed on the `data-dsh-session-tabs`
   attribute and the `--dsh-session-tabs-h` variable this plugin sets — the strip then occupies
   exactly the reserved band, drag handles included.
2. **Session identity and selection come from the official client services**: the Session
   Controller's list snapshot plus the workspace navigation service, which owns the current Session
   (`selection`, `openSession`, `startSession`, `clearMain`). A tab is just a Session id this window
   keeps around.
3. **Which tabs a window has is per-window state**: `sessionStorage` holds the window's own id (and a
   flag for a window born by tearing a tab off) and `localStorage` holds the tab list filed behind
   that id, under `dsh.session-tabs.v1:<window>`. That is what lets several windows show different
   Sessions at once and lets each of them restore its own tabs after a reload. A window handed a
   Session over `?dshTab=` always mints a fresh identity, because Chromium clones `sessionStorage`
   into script-opened windows and inheriting the source window's list would duplicate every tab.
4. **Tearing a tab off asks the shell for a real window.** The desktop shell exposes the preload verb
   `window.dshShell.openSessionWindow({ href, x, y, width, height })`, which the plugin calls with
   the drop point; anywhere else it falls back to `window.open` with a popup geometry. Either way the
   new window is handed the Session as `?dshTab=<sessionId>` on this page's own address, reads it on
   boot through the official `openSession`, and strips the parameter with `history.replaceState` — so
   the mechanism does not depend on who created the window. The launch token is not forwarded; the
   signed cookie is enough.
5. **The caption row is shared with chrome the page cannot see.** The window draws its own controls
   and its native menu bar in that band, and a translucent title bar lets the menu show through. The
   app's own controls are measured at runtime and the menu is reserved for; the strip then starts
   after both. The strip itself is `pointer-events: none` (its own controls opt back in) — otherwise
   it swallowed the click on the sidebar-collapse button, which then looked broken — and the free
   space after the tabs is a separate sibling drag region, because the strip must stay `no-drag` for
   tab dragging and wheel scrolling to work.

## Verify it yourself

```sh
# 1. syntax
node --check index.js && node --check lib/client.js

# 2. headless logic (93 checks): registration, the per-window store, restore, switching,
#    closing, middle click, reorder, tear-off into a new window, a refused shell,
#    the ?dshTab hand-off, housekeeping, the new-session square, and the caption-row geometry
node tools/smoke.mjs

# 3. a running GUI is serving THIS revision (needs a live host and its launcher log)
node tools/verify-live.mjs

# 4. the pre-publish gate: no personal data anywhere, no forbidden APIs in the payload
node tools/audit-public.mjs
```

`tools/smoke.mjs` runs the browser half against a mock React (hooks with persistent cells), a mock
DOM (elements, rects, `ref`, attribute queries) and a mock client context (slots, locale, the Session
Controller, the navigation service) — no browser, no host, no model call.

`tools/verify-live.mjs` reads the last `dsh web: <url>` line a launcher wrote, authenticates with the
launch token, and then proves two things: that `dsh-session-tabs` is a row of the boot graph the page
receives, and that the served bundle carries this revision's markers. It is read-only.

## Security and privacy

The plugin payload (`index.js`, `lib/client.js`, `cordis.patch.yml`, `package.json`) is deliberately
boring, and `tools/audit-public.mjs` fails the build if that changes:

- **No network access** — no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, no
  dynamic import. The plugin talks only to the client's own services.
- **Storage, declared and bounded** — exactly ten `localStorage` / `sessionStorage` calls, all of
  them the per-window state described above: a window id, a detached-window flag, the tab list behind
  that id, and one knob for the caption inset. The keys hold Session ids, the order they were opened
  in, and the label the app already shows on screen — not message content. No cookies, no
  `indexedDB`. The audit prints every declared hit with its reason and fails on the first one beyond
  the declared count.
- **No code or HTML injection** — no `eval`, no `new Function`, no `document.write`, no
  `dangerouslySetInnerHTML`, no `innerHTML` assignment. All UI goes through React elements, and the
  stylesheet is a static string inserted once as a `<style>` tag.
- **Permissions** — none requested; the plugin never touches the clipboard API.
- **Where the pixels and the data go** — nowhere. The strip renders text the app already has, and
  tear-off hands a Session id to a window of the same origin. Nothing leaves the page on the plugin's
  initiative.
- **Contacts with the host** — a running GUI's HTTP endpoint is queried only by the **development
  tools** in `tools/` (read-only: the boot graph and the served bundle), and only at the URL you pass.

Personal data: the repository contains no user paths, no e-mail addresses, no tokens and no logs.
`tools/audit-public.mjs` scans the payload and the whole tree for those, so a re-run is a one-liner
instead of a promise.

## Compatibility

- Written against the **DSH 0.2.0 client contract**: Session selection lives in the `uiWorkspace`
  service (`selection`, `openSession`, `startSession`, `clearMain`), and `dsh.client.inject` lists
  `@deepseek-ai/dsh-client-ui-workspace` so that module is loaded before this one.
- On a client that does not expose `uiWorkspace` the strip still draws correctly but shows **no
  tabs**, because there is no selection to reconcile against. That is the one seam this plugin needs;
  if a future client moves it, the strip fails visibly rather than half-working.
- Caption-row mode needs a shell that hands the page the window's title bar (Electron
  `titleBarStyle: 'hidden'` with `titleBarOverlay`, as this account's own shell does). Without it the
  plugin falls back to a plain band inside the page, and nothing is lost.
- Russian and English copy is registered through the client's own locale service, so the strip
  follows whatever language the app is in.
- Node 22+ for the tooling (`engines`), browser-side: whatever the DSH web client runs on.

## Limitations

- **In the window of the official DeepSeek Harness app a tab cannot be torn off, and that is a host
  limitation, not a setting.** That host denies every `window.open` and gives the page no IPC for
  creating a window. So the tab stays where it is and a hint explains why instead of failing
  silently. Tear-off works in a shell that exposes the `openSessionWindow` bridge and in an ordinary
  browser.
- The caption row belongs to the window, not to the page: the native menu bar is invisible to the
  page and its width can only be reserved for. If the reserve is wrong for your chrome, it is
  overridable (see Diagnostics).
- The same Session can be open in two windows at once. The host is the source of truth, but edits
  made in one window are visible in the other; and the stored "current session" is a single cell
  shared by all windows, so on load each window re-opens **its own** active tab and any disagreement
  corrects itself.
- The window cannot be dragged by the strip once the tabs fill it completely — the same behaviour
  Chrome has. A 4 px sliver at the top and an 8 px column on the right always stay draggable.
- The strip is 36 px tall (or exactly the height the caption reports) and is drawn in the overlay
  layer, so it does not scroll with the app.
- In caption mode a tab is 200 px wide, shrinks to 92 px and only then does the strip scroll.

## Diagnostics

There is no diagnostics object in this plugin; the strip reports through the client's own logger with
a `dsh-session-tabs:` prefix — mount failures, a shell that refused the new window, a `window.open`
that failed, a Session that is gone, a click that could not leave a global panel. Those lines appear
in the page console (`F12`) and in the host's log.

Two things worth knowing when the strip misbehaves:

- **The caption inset is tunable without touching code.** The strip measures the app's own leading
  controls, then adds a reserve for the native menu. Override it, in order of precedence, with
  `window.__DSH_TABS_LEAD__ = <px>` set before the page boots, with
  `localStorage['dsh.session-tabs.lead'] = <px>` (then reload), or with the `--dsh-session-tabs-lead`
  custom property on `<html>`; `0` disables the reserve and leaves the measured chrome only.
- **A crashed slot entry is gone for the rest of the page's life** — that is the framework's own
  error boundary, not this plugin. If the strip disappears, `document.querySelector('[data-slot-error]')`
  naming `shell.overlay` means the entry was retired and only a page reload brings it back.

## License

MIT — see [LICENSE](LICENSE).

---

## По-русски, коротко

Плагин для веб-интерфейса DeepSeek Harness: открытые сессии становятся вкладками в полосе над всем
окном — как в браузере. Клик переключает, `×` / средняя кнопка / контекстное меню закрывают
(сессия при этом **не** удаляется), перетаскивание меняет порядок, а вытаскивание вкладки за пределы
полосы отцепляет её в отдельное окно. Список вкладок окна переживает перезагрузку страницы.

Состояние вкладок — **на окно**: `sessionStorage` хранит идентификатор окна, `localStorage` — список
вкладок этого окна, поэтому несколько окон показывают разные сессии одновременно.

Отцепление идёт через мост оболочки `window.dshShell.openSessionWindow({href,x,y,width,height})`, а
новое окно получает сессию параметром `?dshTab=<sessionId>`; в обычном браузере используется
`window.open`. **В окне официального приложения DeepSeek Harness отцепить вкладку невозможно**: хост
запрещает все `window.open` и не даёт странице IPC для создания окна — вкладка остаётся на месте и
показывает подсказку с причиной.

Когда оболочка отдаёт странице полосу заголовка (caption row), вкладки встают вплотную к верху окна,
нативные кнопки Windows остаются нативными, а их цвет берётся из темы. Полоса сдвинута правее
кнопки панели и нативного меню и прозрачна для кликов, кроме своих элементов.

Проверки: `npm run check`, `npm run smoke` (93 проверки), `npm run audit`; `npm run verify` требует
живого GUI. Лицензия MIT.
