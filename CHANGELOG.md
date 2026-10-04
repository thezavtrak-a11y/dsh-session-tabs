# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-10-04

First public release.

### Added

- Browser-style tabs for the Sessions a window has open: click to switch, `×`, middle click or the
  context menu to close, drag left/right to reorder, and drag out of the strip to tear the tab off
  into its own window.
- The tab list of a window survives a page reload, and a tab disappears when its Session is deleted.
- Housekeeping that drops the tab lists of windows that are gone (untouched for 14 days) instead of
  letting them pile up in storage.
- Russian and English copy, registered through the client's own locale service.
- Caption-row mode: when the shell hands the page the window's title bar, the strip sits in the
  caption row itself and the native Windows buttons stay native (Snap Layouts keep working), with
  their colours taken from the live theme.
- The strip starts to the right of the app's own leading controls and of the native window menu,
  measured at runtime — the app's controls are measured, the menu is reserved for, and the reserve is
  overridable (`window.__DSH_TABS_LEAD__`, `localStorage['dsh.session-tabs.lead']` or the
  `--dsh-session-tabs-lead` custom property; `0` disables it).
- A `New session` square in the strip that delegates to the navigation service (`startSession`),
  so the reuse-or-create policy stays where the service owns it.
- Verification tooling: `tools/smoke.mjs` (93 headless checks), `tools/verify-live.mjs` (a running
  GUI is serving this revision) and `tools/audit-public.mjs` (the pre-publish gate for personal data
  and risky payload APIs).

### Fixed

- **Migration to the DSH 0.2.0 client contract.** The Session Controller's list snapshot no longer
  carries `current`; selection moved to the `uiWorkspace` service (`selection`, `openSession`,
  `startSession`, `clearMain`). The strip used to draw itself correctly and show **no tabs at all**,
  because reconcile read `list.current === undefined`. The plugin now subscribes to `selection` and
  routes opening, starting and clearing through that service.
- **The strip used to swallow the click on the sidebar-collapse button** and the tabs used to run
  under the native window menu: the strip itself is transparent to pointer events
  (`pointer-events: none`, with its own controls opting back in), and the tabs start after the
  measured lead inset.
- The window could not be dragged by the free space after the tabs, because that space sat inside
  the strip, which must stay `no-drag` for tab dragging and wheel scrolling. It is now a separate
  sibling drag region (`.dsh-tabs__fill`).
- A double click on `New session` could start two Sessions, because React state lags a render
  behind: the decision is now held in a ref.
