/**
 * dsh-session-tabs — browser half.
 *
 * Browser-style tabs for open Sessions, drawn by a client plugin: nothing
 * upstream is patched and no file outside this package is touched.
 *
 * How it hangs together:
 *
 *  - The tab strip is ONE list entry in the shell's `shell.overlay` seat. The
 *    frame puts that seat in a click-through absolute layer above every column,
 *    so the strip can sit above the whole app. The frame itself is shifted down
 *    by the strip's height through a CSS rule keyed on an attribute this plugin
 *    sets on the frame element — the strip then occupies exactly the reserved
 *    band, columns and drag handles included.
 *
 *  - Session identity and selection come from the official client Session
 *    Controller: `useSessions` (the list snapshot) plus the Workspace navigation
 *    service, which owns the current Session (`uiWorkspace.openSession`).
 *    A tab is just a Session id this window keeps around; closing a tab never
 *    deletes a Session, exactly like closing a browser tab never deletes a page.
 *
 *  - Which tabs a window has is per-window state (sessionStorage holds the
 *    window id, localStorage the tab list behind it), so several windows can
 *    show several Sessions at once.
 *
 *  - Dragging a tab out of the strip asks the desktop shell for a real new
 *    window (`window.dshShell.openSessionWindow`, an Electron IPC verb) and
 *    falls back to `window.open` in a plain browser. The detached window is
 *    handed the Session through the `dshTab` query parameter, which this same
 *    bundle reads on boot.
 *
 * The whole body lives inside the module-loader factory: registration and all
 * CSS injection happen at materialization, so an HMR reload replaces it cleanly.
 */

window.__ModuleLoader__.load({
	id: 'dsh-session-tabs',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const react = require('react');
		const e = react.createElement;
		const useCallback = react.useCallback;
		const useEffect = react.useEffect;
		const useRef = react.useRef;
		const useState = react.useState;
		const useSyncExternalStore = react.useSyncExternalStore;

		/**
		 * The shell's own icon set, when the module table carries it. Absence is
		 * not fatal: the one glyph this package needs has a hand-drawn fallback.
		 */
		const primitives = (() => {
			try {
				return require('@deepseek-ai/dsh-client-ui-primitives');
			} catch (error) {
				return null;
			}
		})();

		/**
		 * The New Session glyph: the shell's icon while this build exposes one,
		 * otherwise an outline plus drawn here — the button must never be empty.
		 *
		 * @param size - square edge in px.
		 * @returns the icon element.
		 */
		function newSessionIcon(size) {
			for (const name of ['IconNewChatOutline16', 'IconPlusOutline16']) {
				const Icon = primitives === null || primitives === undefined ? undefined : primitives[name];
				if (typeof Icon === 'function' || (typeof Icon === 'object' && Icon !== null)) {
					return e(Icon, { size: size, 'data-icon': name });
				}
			}
			return e('svg', {
				width: size,
				height: size,
				viewBox: '0 0 16 16',
				'aria-hidden': 'true',
				focusable: 'false',
			}, e('path', {
				d: 'M8 3.4v9.2M3.4 8h9.2',
				fill: 'none',
				stroke: 'currentColor',
				'stroke-width': 1.5,
				'stroke-linecap': 'round',
			}));
		}

		/* ════════════════════════════════════════════════════════════════════
		 *  1. VOCABULARY — Russian and English copy for the strip.
		 * ════════════════════════════════════════════════════════════════════ */
		const NS = 'sessionTabs';
		const en = {
			'tab.close': 'Close tab',
			'tab.detach': 'Detach into a new window',
			'tab.running': 'Working…',
			'tab.done': 'Finished — not opened yet',
			'tab.untitled': 'Untitled session',
			'tab.closeOthers': 'Close other tabs',
			'tab.closeAll': 'Close all tabs',
			'drop.detach': 'Release — opens in a new window',
			'new.session': 'New session',
			'error.open': 'This window cannot open new windows: the built-in app denies them. Launch the GUI through DSH Shell (launch.cmd) or open it in a browser to detach tabs.',
			'error.detach': 'Could not open a new window. Launch the GUI through DSH Shell (launch.cmd) or open it in a browser — both can detach a tab.',
			'error.session': 'That session is no longer available.',
			'error.newSession': 'Could not start a new session.',
			'menu.detach': 'Open in a new window',
			'menu.close': 'Close tab',
		};
		const ru = {
			'tab.close': 'Закрыть вкладку',
			'tab.detach': 'Отцепить в новое окно',
			'tab.running': 'Работает…',
			'tab.done': 'Завершена — ещё не открывалась',
			'tab.untitled': 'Сессия без названия',
			'tab.closeOthers': 'Закрыть другие вкладки',
			'tab.closeAll': 'Закрыть все вкладки',
			'drop.detach': 'Отпустите — откроется в новом окне',
			'new.session': 'Новая сессия',
			'error.open': 'Окно встроенного приложения не создаёт новых окон. Откройте GUI в DSH Shell или в браузере — тогда вкладка отцепится.',
			'error.detach': 'Не удалось открыть новое окно. Запустите GUI в DSH Shell (launch.cmd) или откройте его в браузере — там отцепление работает.',
			'error.session': 'Этой сессии больше нет.',
			'error.newSession': 'Не удалось создать сессию.',
			'menu.detach': 'Открыть в новом окне',
			'menu.close': 'Закрыть вкладку',
		};

		/* ════════════════════════════════════════════════════════════════════
		 *  2. CONSTANTS AND STYLES
		 * ════════════════════════════════════════════════════════════════════ */
		/** Frame attribute that switches the shell into "leave room for tabs" mode. */
		const FRAME_ATTR = 'data-dsh-session-tabs';
		/** Strip height in px; the frame's top padding and the strip share it. */
		const BAR_HEIGHT = 36;
		/** Query parameter carrying a handed-over Session into a detached window. */
		const HANDOFF_PARAM = 'dshTab';
		/** localStorage prefix holding one window's tab list. */
		const STATE_PREFIX = 'dsh.session-tabs.v1:';
		/** sessionStorage key holding this window's stable id. */
		const WINDOW_KEY = 'dsh.session-tabs.window';
		/** sessionStorage flag marking a window that was born by detaching a tab. */
		const DETACHED_KEY = 'dsh.session-tabs.detached';
		/** Tab lists untouched for this long are dropped during housekeeping. */
		const STATE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
		/** Pointer travel in px before a press counts as a drag rather than a click. */
		const DRAG_THRESHOLD = 5;
		/** How far outside the strip the pointer must be to mean "detach". */
		const DETACH_MARGIN = 12;
		/** Breathing room between the caption's left edge and the drag square. */
		const CAPTION_LEFT_GAP = 6;
		/**
		 * Caption-row left inset reserved for chrome the page cannot see: in this UI
		 * version the desktop window draws its native menu bar in the caption band, and
		 * the app's translucent title bar lets it show through. Shifted tabs must start
		 * to the right of it. Overridable — see {@link captionLeadReserve}.
		 */
		const CAPTION_LEAD_RESERVE = 200;
		/** localStorage key holding a per-window override of that inset. */
		const LEAD_KEY = 'dsh.session-tabs.lead';
		/** Default geometry of a torn-off window. */
		const DETACH_WIDTH = 1180;
		const DETACH_HEIGHT = 820;
		const CSS_TAG_ID = 'dsh-session-tabs/tabs.css';

		const CSS = [
			/* Leave room for the strip: the frame is a grid whose rows fill 100%,
			 * so padding + border-box shrinks the content area instead of pushing
			 * it out of the overflow-hidden box. `[data-side]` re-anchors the two
			 * column drag handles below the strip. */
			`[${FRAME_ATTR}]{padding-top:var(--dsh-session-tabs-h,${BAR_HEIGHT}px);box-sizing:border-box}`,
			`[${FRAME_ATTR}] [data-side]{top:var(--dsh-session-tabs-h,${BAR_HEIGHT}px)}`,
			'.dsh-tabs{position:absolute;top:0;left:0;right:0;height:var(--dsh-session-tabs-h,' + BAR_HEIGHT + 'px);display:flex;align-items:stretch;gap:4px;padding:4px 8px 0;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#15171b));border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));font-family:var(--dsw-font-family,inherit);font-size:var(--dsw-font-xs-13,13px);color:var(--dsw-alias-label-secondary,#9aa0a6);user-select:none;pointer-events:none}',
			'.dsh-tabs__strip{display:flex;align-items:flex-end;gap:2px;flex:1 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}',
			'.dsh-tabs__strip::-webkit-scrollbar{height:0}',
			'.dsh-tabs__tab{position:relative;display:flex;align-items:center;gap:6px;flex:1 1 0;min-width:92px;max-width:240px;height:calc(var(--dsh-session-tabs-h,' + BAR_HEIGHT + 'px) - 4px);padding:0 6px 0 10px;border:1px solid transparent;border-bottom:none;border-radius:8px 8px 0 0;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);overflow:hidden;cursor:default;transition:background .12s ease}',
			'.dsh-tabs__tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
			'.dsh-tabs__tab[data-active]{background:var(--dsw-alias-bg-base,#0f1115);color:var(--dsw-alias-label-primary,#e8eaed);border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.25))}',
			'.dsh-tabs__tab[data-drag]{opacity:.5}',
			'.dsh-tabs__dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:transparent}',
			'.dsh-tabs__tab[data-running] .dsh-tabs__dot{background:var(--dsw-alias-brand-primary,#4d6bfe);animation:dsh-tabs-pulse 1.1s ease-in-out infinite}',
			'.dsh-tabs__tab[data-done] .dsh-tabs__dot{background:var(--dsw-alias-state-success-primary,#2ea043)}',
			'@keyframes dsh-tabs-pulse{0%,100%{opacity:.3}50%{opacity:1}}',
			'.dsh-tabs__title{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;line-height:1.2}',
			'.dsh-tabs__close{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:none;border-radius:50%;background:transparent;color:inherit;font-size:15px;line-height:1;cursor:pointer;opacity:0;transition:opacity .12s ease,background .12s ease}',
			'.dsh-tabs__tab:hover .dsh-tabs__close,.dsh-tabs__tab[data-active] .dsh-tabs__close{opacity:.7}',
			'.dsh-tabs__close:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.25))}',
			'.dsh-tabs__ghost{position:fixed;z-index:2147483000;display:flex;align-items:center;gap:8px;max-width:280px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:8px;background:var(--dsw-alias-bg-layer-2,#1c1f24);box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.45));color:var(--dsw-alias-label-primary,#e8eaed);font-size:var(--dsw-font-xs-13,13px);pointer-events:none}',
			'.dsh-tabs__ghostTitle{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
			'.dsh-tabs__ghostHint{color:var(--dsw-alias-label-tertiary,#8b9096);white-space:nowrap}',
			'.dsh-tabs__toast{position:absolute;top:calc(var(--dsh-session-tabs-h,' + BAR_HEIGHT + 'px) + 10px);left:50%;transform:translateX(-50%);max-width:70%;padding:7px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:8px;background:var(--dsw-alias-bg-layer-3,#22262c);box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.4));color:var(--dsw-alias-label-primary,#e8eaed);text-align:center;pointer-events:none}',
			'.dsh-tabs__menu{position:fixed;z-index:2147483001;min-width:220px;padding:4px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:10px;background:var(--dsw-alias-bg-layer-3,#22262c);box-shadow:var(--dsw-shadow-lv3,0 10px 30px rgba(0,0,0,.5));color:var(--dsw-alias-label-primary,#e8eaed);font-size:var(--dsw-font-xs-13,13px)}',
			'.dsh-tabs__menuItem{display:block;width:100%;padding:7px 10px;border:none;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
			'.dsh-tabs__menuItem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}',
			/* The New Session square that opens the row, left of the tabs. */
			'.dsh-tabs__new{flex:0 0 auto;align-self:center;display:flex;align-items:center;justify-content:center;padding:0;border:none;border-radius:6px;background:transparent;color:inherit;cursor:pointer;transition:background .12s ease,color .12s ease}',
			'.dsh-tabs__new:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.22));color:var(--dsw-alias-label-primary,#e8eaed)}',
			'.dsh-tabs__new:disabled{opacity:.45;cursor:default}',
			/* Free space right of the tabs: a drag region of its own, outside the
			 * scrolling strip, so grabbing it moves the window. */
			'.dsh-tabs__fill{flex:1 1 auto;min-width:0;align-self:stretch;pointer-events:none}',
			/* The band is shared with chrome that is not ours — this UI parks the
			 * sidebar toggle and the window's native menu in it — so the bar itself
			 * must not swallow clicks: it takes none, and only its own controls opt
			 * back in. Otherwise the app's toggle sits under the bar and stops
			 * working. */
			'.dsh-tabs > .dsh-tabs__new,.dsh-tabs > .dsh-tabs__strip,.dsh-tabs > .dsh-tabs__menu{pointer-events:auto}',
			/* Caption-row mode: the shell hides the native title bar and draws its
			 * window controls as an overlay, so this bar IS the caption. Each
			 * interactive control keeps its own region; the free space after the tabs
			 * drags the window; the native buttons keep the space the overlay
			 * reported for them. */
			'.dsh-tabs[data-titlebar]{-webkit-app-region:no-drag}',
			'.dsh-tabs[data-titlebar] > *{-webkit-app-region:no-drag}',
			'.dsh-tabs[data-titlebar] .dsh-tabs__fill{-webkit-app-region:drag}',
			/* Tabs stop stretching in caption-row mode: the leftover width belongs to
			 * that drag region (and to nothing at all once the tabs overflow). */
			'.dsh-tabs[data-titlebar] .dsh-tabs__strip{flex:0 1 auto}',
			'.dsh-tabs[data-titlebar] .dsh-tabs__tab{flex:0 1 auto;width:200px}',
		].join('');

		/** Inject the stylesheet once per page (idempotent across HMR reloads). */
		function injectCss() {
			if (typeof document === 'undefined') return;
			if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') !== null) return;
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-session-tabs';
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/* ════════════════════════════════════════════════════════════════════
		 *  3. PER-WINDOW TAB STATE
		 *
		 *  A window owns a stable id (sessionStorage) and a tab list persisted
		 *  under that id (localStorage), so a reload restores this window's tabs
		 *  and two windows never fight over one key. The snapshot is immutable
		 *  between mutations, which is what makes it a legal uSES source.
		 * ════════════════════════════════════════════════════════════════════ */

		/** localStorage reads never throw outward (private mode, quota, JSON rot). */
		function readStored(key) {
			try {
				const text = window.localStorage.getItem(key);
				if (text === null) return null;
				const value = JSON.parse(text);
				return value !== null && typeof value === 'object' ? value : null;
			} catch (error) {
				return null;
			}
		}

		/** The Session id handed over by a detaching window, if any. */
		function readHandoff() {
			try {
				const url = new URL(window.location.href);
				const value = url.searchParams.get(HANDOFF_PARAM);
				if (value === null) return null;
				/* Consume it: a later reload of this window must not re-hand the
				 * Session over, and the address bar stays clean. */
				url.searchParams.delete(HANDOFF_PARAM);
				window.history.replaceState(null, '', url.pathname + url.search + url.hash);
				return value;
			} catch (error) {
				return null;
			}
		}

		/** The address a detached window must load to show one Session. */
		function handoffHref(sessionId) {
			const url = new URL(window.location.href);
			url.searchParams.set(HANDOFF_PARAM, sessionId);
			/* The signed cookie already authenticates this origin (verified: a
			 * token-less load of the app boots), so the launch token is dropped —
			 * a second window needs no token and must not carry one. */
			url.searchParams.delete('token');
			return url.toString();
		}

		/** Stable ids for windows and for the window.open fallback's frame name. */
		function randomId() {
			try {
				if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
			} catch (error) {
				/* fall through to the time-based id */
			}
			return Date.now().toString(36) + Math.random().toString(36).slice(2);
		}

		const isSessionId = (value) => typeof value === 'string' && value.length > 0;

		/**
		 * Caption-row geometry as the window controls overlay reports it.
		 *
		 * `active` is true only when the desktop shell hid its native title bar and
		 * kept the system window controls as an overlay; in a plain browser, or in
		 * a shell with the stock title bar, every caption-row behaviour stays off.
		 * `height` is the band the buttons occupy, `left`/`right` the insets they
		 * need on either side (Windows reserves the right one for min/max/close).
		 *
		 * @returns the geometry, with the strip height as the fallback height.
		 */
		function readCaption() {
			const off = { active: false, height: BAR_HEIGHT, left: 0, right: 0 };
			try {
				const overlay = navigator.windowControlsOverlay;
				if (overlay === undefined || overlay === null || overlay.visible !== true) return off;
				const rect = typeof overlay.getTitlebarAreaRect === 'function' ? overlay.getTitlebarAreaRect() : null;
				if (rect === undefined || rect === null) return { active: true, height: BAR_HEIGHT, left: 0, right: 0 };
				const viewport = typeof window.innerWidth === 'number' && window.innerWidth > 0 ? window.innerWidth : 0;
				return {
					active: true,
					height: rect.height > 0 ? Math.round(rect.height) : BAR_HEIGHT,
					left: Math.max(0, Math.round(rect.x)),
					right: Math.max(0, Math.round(viewport - rect.x - rect.width)),
				};
			} catch (error) {
				return off;
			}
		}

		/**
		 * Width of the application's own window-chrome controls at the frame's top-left.
		 *
		 * In caption-row mode the band belongs to the window rather than to a panel, and
		 * this UI parks the sidebar toggle there. The strip has to start after those
		 * controls instead of covering them. Only controls that fit entirely inside the
		 * band count — a panel header that merely reaches into it is content, not chrome.
		 * The search is confined to the frame's leading column, so the measurement cannot
		 * depend on the layout change it causes.
		 *
		 * @param frame - the frame element the shell overlay lives in.
		 * @param band - caption band height in px.
		 * @returns the right edge of that chrome, px from the frame's left edge.
		 */
		function chromeLeadingWidth(frame, band) {
			if (frame === null || band <= 0) return 0;
			const leading = frame.firstElementChild;
			if (leading === null || leading === undefined) return 0;
			const frameBox = frame.getBoundingClientRect();
			const limit = frameBox.left + Math.max(120, frameBox.width * 0.33);
			let right = 0;
			for (const node of leading.querySelectorAll('button, [role="button"], a[href]')) {
				if (node.closest('[data-dsh-tabs]') !== null) continue;
				const box = node.getBoundingClientRect();
				if (box.width === 0 || box.height === 0) continue;
				if (box.left > limit) continue;
				if (box.top < frameBox.top - 2 || box.bottom > frameBox.top + band + 6) continue;
				right = Math.max(right, box.right - frameBox.left);
			}
			return Math.round(right);
		}

		/**
		 * Left inset the strip keeps clear for chrome the page cannot measure.
		 *
		 * The window's native menu bar and the host's own leading controls are drawn by
		 * the desktop shell, not by the page: the strip can see neither their width nor
		 * their existence, and the app's title bar is translucent enough that they show
		 * through it. The app's own controls ARE measurable — {@link chromeLeadingWidth}
		 * adds those on top. Override per host with `window.__DSH_TABS_LEAD__ = <px>`
		 * (set it before the page boots) or with the `--dsh-session-tabs-lead` custom
		 * property on the document element; `0` disables the reservation.
		 *
		 * @returns the inset in px.
		 */
		function captionLeadReserve() {
			try {
				const override = window.__DSH_TABS_LEAD__;
				if (typeof override === 'number' && Number.isFinite(override) && override >= 0) return Math.round(override);
			} catch (error) { /* no global override */ }
			try {
				const stored = Number.parseFloat(window.localStorage.getItem(LEAD_KEY));
				if (Number.isFinite(stored) && stored >= 0) return Math.round(stored);
			} catch (error) { /* no stored override */ }
			try {
				const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsh-session-tabs-lead').trim();
				const parsed = Number.parseFloat(raw);
				if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
			} catch (error) { /* no stylesheet override */ }
			return CAPTION_LEAD_RESERVE;
		}

		/** `rgb()`/`rgba()` as the plain hex the window-controls overlay accepts. */		function toHexColor(value) {
			if (typeof value !== 'string') return undefined;
			const match = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(value);
			if (match === null) return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : undefined;
			const hex = (part) => Number(part).toString(16).padStart(2, '0');
			return '#' + hex(match[1]) + hex(match[2]) + hex(match[3]);
		}

		/**
		 * One window's tab list.
		 *
		 * @param ctx - client context (used only for diagnostics).
		 * @returns the store: an immutable snapshot plus the mutation verbs.
		 */
		function createTabStore(ctx) {
			const handoff = readHandoff();
			let detached = handoff !== null;
			let windowId = null;
			try {
				if (!detached) detached = window.sessionStorage.getItem(DETACHED_KEY) === '1';
				windowId = window.sessionStorage.getItem(WINDOW_KEY);
			} catch (error) {
				/* a window without sessionStorage is still usable, just not identified */
			}
			/* A handed-over Session always mints a fresh window identity: Chromium
			 * clones sessionStorage into script-opened windows, and inheriting the
			 * source window's tab list would duplicate every tab. */
			if (handoff !== null || !isSessionId(windowId)) {
				windowId = randomId();
			}
			try {
				window.sessionStorage.setItem(WINDOW_KEY, windowId);
				if (detached) window.sessionStorage.setItem(DETACHED_KEY, '1');
			} catch (error) {
				/* ignore */
			}

			const storageKey = STATE_PREFIX + windowId;
			const stored = handoff === null ? readStored(storageKey) : null;
			const tabs = handoff !== null
				? [handoff]
				: Array.isArray(stored?.tabs) ? stored.tabs.filter(isSessionId) : [];
			const active = handoff !== null
				? handoff
				: isSessionId(stored?.active) ? stored.active : null;

			let snapshot = Object.freeze({ tabs, active, detached });
			const listeners = new Set();

			/** Publish one immutable snapshot and persist it. */
			const publish = (next) => {
				snapshot = Object.freeze({
					tabs: next.tabs === undefined ? snapshot.tabs : next.tabs,
					active: next.active === undefined ? snapshot.active : next.active,
					detached: snapshot.detached,
				});
				try {
					window.localStorage.setItem(storageKey, JSON.stringify({
						tabs: snapshot.tabs,
						active: snapshot.active,
						at: Date.now(),
					}));
				} catch (error) {
					/* a full or blocked localStorage must not break tab switching */
				}
				for (const listener of listeners) listener();
			};

			/** Drop tab lists of windows that have not been seen for a long while. */
			const housekeeping = () => {
				try {
					const now = Date.now();
					const stale = [];
					for (let index = 0; index < window.localStorage.length; index += 1) {
						const key = window.localStorage.key(index);
						if (key === null || !key.startsWith(STATE_PREFIX) || key === storageKey) continue;
						const value = readStored(key);
						const at = typeof value?.at === 'number' ? value.at : 0;
						if (now - at > STATE_TTL_MS) stale.push(key);
					}
					for (const key of stale) window.localStorage.removeItem(key);
				} catch (error) {
					/* ignore */
				}
			};

			return {
				windowId,
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				getSnapshot: () => snapshot,
				housekeeping,
				/** Track a Session that just became current. Idempotent. */
				adopt(sessionId) {
					const known = snapshot.tabs.includes(sessionId);
					if (known && snapshot.active === sessionId) return;
					publish({
						tabs: known ? snapshot.tabs : [...snapshot.tabs, sessionId],
						active: sessionId,
					});
				},
				/** Mark a tab active without touching the Session Controller. */
				activate(sessionId) {
					if (snapshot.active === sessionId) return;
					publish({ active: sessionId });
				},
				/** Forget a tab. Returns the neighbour that should become active. */
				close(sessionId) {
					const index = snapshot.tabs.indexOf(sessionId);
					if (index === -1) return snapshot.active;
					const tabs = snapshot.tabs.filter((id) => id !== sessionId);
					let active = snapshot.active;
					if (active === sessionId) active = tabs[index] ?? tabs[index - 1] ?? null;
					publish({ tabs, active });
					return active;
				},
				/** Close every tab but one (and close all when given null). */
				closeOthers(keep) {
					const tabs = keep === null ? [] : snapshot.tabs.filter((id) => id === keep);
					let active = snapshot.active;
					if (active === null || !tabs.includes(active)) active = tabs.length > 0 ? tabs[0] : null;
					publish({ tabs, active });
					return active;
				},
				/** Reorder one tab to an absolute index (drag reordering). */
				move(sessionId, index) {
					const from = snapshot.tabs.indexOf(sessionId);
					if (from === -1) return;
					const target = Math.max(0, Math.min(snapshot.tabs.length - 1, index));
					if (from === target) return;
					const tabs = [...snapshot.tabs];
					tabs.splice(from, 1);
					tabs.splice(target, 0, sessionId);
					publish({ tabs });
				},
				/** Drop tabs whose Session left the host list (deleted or archived). */
				prune(known) {
					const tabs = snapshot.tabs.filter((id) => known[id] !== undefined);
					if (tabs.length === snapshot.tabs.length) return;
					let active = snapshot.active;
					if (active !== null && !tabs.includes(active)) active = tabs.length > 0 ? tabs[0] : null;
					publish({ tabs, active });
				},
				/** Refresh the immutable snapshot without changing it (diagnostics). */
				touch() {
					publish({});
				},
			};
		}

		/* ════════════════════════════════════════════════════════════════════
		 *  4. NEW SESSION — the sidebar button's semantics, from the tab strip
		 * ════════════════════════════════════════════════════════════════════ */

		/**
		 * The workspace holding the most recently touched Session, which is where a
		 * New Session belongs when the current one says nothing.
		 *
		 * @param items - workspace rows.
		 * @param byId - Session summaries by id.
		 * @returns the workspace id, or undefined when there is no workspace at all.
		 */
		function recentWorkspace(items, byId) {
			let selected;
			let selectedTime = Number.NEGATIVE_INFINITY;
			for (const workspace of items) {
				let latest = Number.NEGATIVE_INFINITY;
				for (const sessionId of workspace.sessionIds) {
					const summary = byId[sessionId];
					if (summary !== undefined) latest = Math.max(latest, summary.updatedAt);
				}
				if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt);
				if (selected === undefined || latest > selectedTime) {
					selected = workspace.workspaceId;
					selectedTime = latest;
				}
			}
			return selected;
		}

		/**
		 * Start a Session exactly the way the sidebar's own New Session button does:
		 * reuse a blank Session of this window's workspace, create one there when none
		 * is blank, and fall back to the New Session view when the host knows no
		 * workspace. 0.2.0 keeps that policy in the Workspace navigation service, so
		 * this delegates to it instead of restating it.
		 *
		 * @param ctx - client context carrying `uiWorkspace`.
		 * @returns undefined: the strip learns the new Session from the selection.
		 */
		async function startSession(ctx) {
			/* 0.2.0 owns this decision in the Workspace navigation service: it reuses a
			 * blank Session of the window's workspace or creates one there, then selects
			 * it — the same path the sidebar's «Новая сессия» takes. The strip adds the
			 * tab from the selection change, so no Session id is returned. */
			if (navigation === null || navigation === undefined || typeof navigation.startSession !== 'function') {
				throw new Error('dsh-session-tabs: the Workspace navigation service is unavailable');
			}
			navigation.startSession();
			return undefined;
		}

		/* ════════════════════════════════════════════════════════════════════
		 *  5. DETACH — ask the shell for a real new window
		 * ════════════════════════════════════════════════════════════════════ */

		/**
		 * Open one Session in a separate window, positioned under the pointer.
		 *
		 * The Electron shell exposes `window.dshShell.openSessionWindow` (its
		 * preload bridge); anywhere else the plain `window.open` popup path is
		 * the fallback, which is also what a browser tab uses.
		 *
		 * @param ctx - client context, for diagnostics.
		 * @param sessionId - Session to hand over.
		 * @param at - drop point in screen coordinates and the desired size.
		 * @returns whether a window was created.
		 */
		async function openDetachedWindow(ctx, sessionId, at) {
			const href = handoffHref(sessionId);
			const bridge = window.dshShell;
			if (bridge !== undefined && bridge !== null && typeof bridge.openSessionWindow === 'function') {
				try {
					const result = await bridge.openSessionWindow({
						href,
						x: at.x,
						y: at.y,
						width: at.width,
						height: at.height,
					});
					return result !== false;
				} catch (error) {
					ctx.logger.warn('dsh-session-tabs: shell refused the detached window', error);
					return false;
				}
			}
			try {
				const features = [
					'popup=yes',
					'width=' + at.width,
					'height=' + at.height,
					'left=' + at.x,
					'top=' + at.y,
				].join(',');
				const handle = window.open(href, 'dsh-session-' + sessionId.slice(0, 12), features);
				return handle !== null && handle !== undefined;
			} catch (error) {
				ctx.logger.warn('dsh-session-tabs: window.open failed', error);
				return false;
			}
		}

		/* ════════════════════════════════════════════════════════════════════
		 *  6. THE STRIP
		 * ════════════════════════════════════════════════════════════════════ */

		/**
		 * The tab strip.
		 *
		 * @param props - framework standard seats (`useSessions`, `usePanelInfo`),
		 *   the bound translate function and the client context this package
		 *   supplies through the registration wrapper.
		 * @returns the strip element tree.
		 */
		function SessionTabs(props) {
			const t = props.t;
			const ctx = props.ctx;
			const list = props.useSessions((state) => state);
			const panelId = props.usePanelInfo((info) => info.activePanelId);
			const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

			const stripRef = useRef(null);
			const barRef = useRef(null);
			const menuRef = useRef(null);
			const dragRef = useRef(null);
			/** Whether this window's own tab has been claimed yet (one-shot). */
			const restoredRef = useRef(false);
			/** The Session this window last asked the controller to open, and when. */
			const pendingRef = useRef(null);
			/** Reconcile passes, so an unconfirmed open can time out after one commit. */
			const passRef = useRef(0);
			const toastTimer = useRef(null);
			const [dragging, setDragging] = useState(null);
			const [ghost, setGhost] = useState(null);
			const [toast, setToast] = useState(null);
			const [menu, setMenu] = useState(null);
			/** True while the New Session round-trip is in flight. */
			const [creating, setCreating] = useState(false);
			/** True while this strip doubles as the window's caption row. */
			const [caption, setCaption] = useState(readCaption);
			const captionRow = caption.active;

			/* ── shell integration ───────────────────────────────────────── */

			/* The window-controls overlay appears, vanishes or changes size with the
			 * shell's mode and the window state; its geometry events carry all of it. */
			useEffect(() => {
				const overlay = navigator.windowControlsOverlay;
				if (overlay === undefined || overlay === null || typeof overlay.addEventListener !== 'function') return undefined;
				const sync = () => setCaption(readCaption());
				overlay.addEventListener('geometrychange', sync);
				sync();
				return () => overlay.removeEventListener('geometrychange', sync);
			}, []);

			/* Paint the native window buttons in the strip's colours: the caption
			 * band shows what the bar shows, and the theme can change at runtime. */
			useEffect(() => {
				if (!captionRow) return undefined;
				const bridge = window.dshShell;
				if (bridge === undefined || bridge === null || typeof bridge.setTitleBarOverlay !== 'function') return undefined;
				const push = () => {
					const bar = barRef.current;
					if (bar === null) return;
					const style = getComputedStyle(bar);
					bridge.setTitleBarOverlay({
						color: toHexColor(style.backgroundColor),
						symbolColor: toHexColor(style.color),
						height: caption.height,
					});
				};
				push();
				const observer = new MutationObserver(push);
				observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'class', 'data-ds-dark-theme'] });
				return () => observer.disconnect();
			}, [captionRow, caption.height]);

			/* Mark the frame so the stylesheet can reserve the strip's band. Runs
			 * after every render because a shell remount replaces the frame node;
			 * the check makes the steady-state cost one attribute read. */
			useEffect(() => {
				const overlay = document.querySelector('[data-shell-overlay]');
				const frame = overlay === null ? null : overlay.parentElement;
				if (frame === null) return;
				frame.setAttribute(FRAME_ATTR, '');
				/* One variable drives both the reservation and the strip: in
				 * caption-row mode it is the real caption band height. */
				frame.style.setProperty('--dsh-session-tabs-h', caption.height + 'px');

				/* The band is shared with chrome that is not ours. The app's sidebar
				 * toggle sits at the frame's top-left in every mode, and in caption-row
				 * mode the desktop shell also draws the window's native menu bar beside
				 * it. The app's own control is measurable ({@link chromeLeadingWidth});
				 * the native menu is not, so caption-row mode adds the documented
				 * reserve for it. Tabs that start left of either one would cover a
				 * control the user needs. */
				const leading = chromeLeadingWidth(frame, caption.height);
				const left = Math.max(caption.left, leading)
					+ CAPTION_LEFT_GAP
					+ (captionRow ? captionLeadReserve() : 0);
				const bar = barRef.current;
				if (bar !== null) bar.style.paddingLeft = left + 'px';
			});

			/* Horizontal wheel scrolling, like a browser's tab strip. Registered
			 * natively because React's wheel listener is passive. */
			useEffect(() => {
				const strip = stripRef.current;
				if (strip === null) return undefined;
				const onWheel = (event) => {
					if (strip.scrollWidth <= strip.clientWidth) return;
					if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
					strip.scrollLeft += event.deltaY;
					event.preventDefault();
				};
				strip.addEventListener('wheel', onWheel, { passive: false });
				return () => strip.removeEventListener('wheel', onWheel);
			}, [snapshot.tabs.length]);

			/* Keep the active tab visible when selection moves. */
			useEffect(() => {
				const strip = stripRef.current;
				if (strip === null) return;
				const node = strip.querySelector('[data-active]');
				if (node !== null && typeof node.scrollIntoView === 'function') {
					node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
				}
			}, [snapshot.active]);

			/* One-shot housekeeping of other windows' stale tab lists. */
			useEffect(() => {
				store.housekeeping();
			}, []);

			/* Transient message under the strip. */
			const notify = useCallback((text) => {
				setToast(text);
				if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
				toastTimer.current = window.setTimeout(() => {
					toastTimer.current = null;
					setToast(null);
				}, 6000);
			}, []);
			useEffect(() => () => {
				if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
			}, []);

			/* ── Session Controller wiring ───────────────────────────────── */

			/* 0.2.0: the app's current Session is the Workspace navigation selection
			 * (`dsh.sessions.current`), not a field on the Session list. Subscribing to
			 * it is what makes a sidebar click, a New Session or a handoff move the
			 * active tab. */
			const current = useSyncExternalStore(subscribeSelection, currentSessionId, currentSessionId);

			const openSession = useCallback((sessionId) => {
				if (panelId !== null) {
					try {
						/* A global panel (settings, cost, …) replaces the centre;
						 * selecting a tab must bring the Conversation back. */
						ctx.layout.selectPanel(null);
					} catch (error) {
						ctx.logger.warn('dsh-session-tabs: could not leave the global panel', error);
					}
				}
				/* The selection write is local and synchronous; until the list
				 * reports it back, the reconcile pass must not treat the previous
				 * current as the app's choice — that is what would open a tab the
				 * user never asked for after a handoff. */
				pendingRef.current = { id: sessionId, pass: passRef.current };
				try {
					navigation.openSession(sessionId);
				} catch (error) {
					pendingRef.current = null;
					ctx.logger.warn('dsh-session-tabs: session is gone', error);
					store.close(sessionId);
					notify(t('error.session'));
				}
			}, [panelId, notify, t]);

			/* The New Session square: same semantics as the sidebar's button, so the
			 * new Session lands in the workspace this window is working in. A ref
			 * guards the round-trip — setState lags a render, so two rapid clicks
			 * could otherwise start two Sessions. */
			const creatingRef = useRef(false);
			const onNewSession = useCallback(async () => {
				if (creatingRef.current) return;
				creatingRef.current = true;
				setCreating(true);
				try {
					const sessionId = await startSession(ctx);
					if (sessionId !== undefined) openSession(sessionId);
				} catch (error) {
					ctx.logger.warn('dsh-session-tabs: could not start a session', error);
					notify(t('error.newSession'));
				} finally {
					creatingRef.current = false;
					setCreating(false);
				}
			}, [openSession, notify, t]);

			/* One reconciliation pass per list change — the whole selection policy:
			 *
			 *   1. while an open() this window asked for is unconfirmed, wait: the
			 *      selection still reports the previous current, and adopting it would
			 *      open a tab nobody asked for;
			 *   2. on the first pass this window's own tab wins. The durable
			 *      selection is one cell shared by every window, so a second window
			 *      must re-open the tab it was born with;
			 *   3. afterwards whatever the app made current (a sidebar click, a new
			 *      Session, a fork) becomes the active tab, and Sessions that left
			 *      the host list lose their tabs.
			 *
			 * `current` is the Workspace navigation selection (0.2.0); the Session
			 * list itself no longer carries a current field.
			 */
			useEffect(() => {
				passRef.current += 1;
				const pending = pendingRef.current;
				if (pending !== null) {
					const confirmed = current === pending.id;
					/* One commit of patience: the store publishes synchronously, so a
					 * surviving mismatch means the app went elsewhere and wins. */
					if (confirmed || pending.pass < passRef.current) pendingRef.current = null;
					else return;
				}
				if (!restoredRef.current) {
					const wanted = snapshot.active;
					if (wanted === null) {
						if (list.phase !== 'ready') return;
						restoredRef.current = true;
					} else if (current === wanted) {
						restoredRef.current = true;
					} else if (list.byId[wanted] !== undefined) {
						restoredRef.current = true;
						openSession(wanted);
						return;
					} else {
						/* Missing while the list is still arriving is normal; missing
						 * once it is ready means the Session is gone for good. */
						if (list.phase !== 'ready') return;
						restoredRef.current = true;
						store.close(wanted);
						return;
					}
				}
				if (list.phase === 'ready') store.prune(list.byId);
				if (current === undefined) {
					if (snapshot.active !== null) store.activate(null);
					return;
				}
				store.adopt(current);
			}, [list, current, snapshot.active, openSession]);

			/* ── tab actions ─────────────────────────────────────────────── */

			/* Settle the window after tabs went away: move to the neighbour, or
			 * leave the tab strip empty. A torn-off window then closes like a
			 * browser window, while the main window returns to the New Session
			 * view; closing a tab never deletes a Session. */
			const settle = useCallback((next) => {
				if (next !== null) {
					openSession(next);
					return;
				}
				if (snapshot.detached) {
					window.close();
					return;
				}
				try {
					navigation.clearMain();
				} catch (error) {
					ctx.logger.warn('dsh-session-tabs: could not clear the selection', error);
				}
			}, [snapshot.detached, openSession]);

			const closeTab = useCallback((sessionId) => {
				const wasActive = snapshot.active === sessionId;
				const next = store.close(sessionId);
				if (wasActive) settle(next);
			}, [snapshot.active, settle]);

			const detachTab = useCallback(async (sessionId, at) => {
				const ok = await openDetachedWindow(ctx, sessionId, at);
				if (!ok) {
					/* Two different failures, two different instructions: a shell that
					 * refused the IPC verb is fixed by the shell, while a window with no
					 * bridge at all (the built-in app) has to move to a host that allows
					 * new windows. */
					notify(window.dshShell ? t('error.detach') : t('error.open'));
					return;
				}
				closeTab(sessionId);
			}, [closeTab, notify, t]);

			/* ── pointer drag: reorder inside, detach outside ────────────── */

			const onTabPointerDown = useCallback((event, sessionId) => {
				if (event.button !== 0) return;
				const target = event.target;
				if (target !== null && typeof target.closest === 'function' && target.closest('.dsh-tabs__close') !== null) return;
				const element = event.currentTarget;
				dragRef.current = {
					sessionId,
					pointerId: event.pointerId,
					startX: event.clientX,
					startY: event.clientY,
					moved: false,
					element,
				};
				try {
					element.setPointerCapture(event.pointerId);
				} catch (error) {
					/* capture is an optimisation; the handlers still fire */
				}
			}, []);

			const onTabPointerMove = useCallback((event) => {
				const drag = dragRef.current;
				if (drag === null || drag.pointerId !== event.pointerId) return;
				if (!drag.moved) {
					const dx = Math.abs(event.clientX - drag.startX);
					const dy = Math.abs(event.clientY - drag.startY);
					if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return;
					drag.moved = true;
					setDragging(drag.sessionId);
				}
				const strip = stripRef.current;
				const bar = strip === null ? null : strip.parentElement;
				const rect = bar === null ? null : bar.getBoundingClientRect();
				const outside = rect === null
					? false
					: event.clientY > rect.bottom + DETACH_MARGIN
						|| event.clientY < rect.top - DETACH_MARGIN
						|| event.clientX < rect.left - DETACH_MARGIN
						|| event.clientX > rect.right + DETACH_MARGIN;
				/* The drop decision reads this ref, never the render that follows the
				 * state write: a pointerup can arrive before React re-renders. */
				drag.outside = outside;
				const row = list.byId[drag.sessionId];
				setGhost({
					x: event.clientX + 12,
					y: event.clientY + 12,
					title: row === undefined ? t('tab.untitled') : row.displayTitle,
					outside,
				});
				if (!outside && strip !== null) {
					/* Live reordering: the tab follows the pointer's target slot. */
					const nodes = strip.querySelectorAll('[data-tab-id]');
					let best = -1;
					let bestDistance = Infinity;
					for (let index = 0; index < nodes.length; index += 1) {
						const box = nodes[index].getBoundingClientRect();
						const distance = Math.abs(box.left + box.width / 2 - event.clientX);
						if (distance < bestDistance) {
							bestDistance = distance;
							best = index;
						}
					}
					if (best !== -1) store.move(drag.sessionId, best);
				}
			}, [list, t]);

			const onTabPointerUp = useCallback((event) => {
				const drag = dragRef.current;
				if (drag === null || drag.pointerId !== event.pointerId) return;
				dragRef.current = null;
				setDragging(null);
				setGhost(null);
				try {
					drag.element.releasePointerCapture(event.pointerId);
				} catch (error) {
					/* already released */
				}
				if (!drag.moved) {
					store.activate(drag.sessionId);
					openSession(drag.sessionId);
					return;
				}
				if (drag.outside === true) {
					detachTab(drag.sessionId, {
						x: Math.max(0, Math.round(event.screenX - 120)),
						y: Math.max(0, Math.round(event.screenY - 14)),
						width: Math.max(960, Math.min(window.outerWidth || DETACH_WIDTH, 2400)),
						height: Math.max(640, Math.min(window.outerHeight || DETACH_HEIGHT, 1600)),
					});
				}
			}, [openSession, detachTab]);

			const onTabPointerCancel = useCallback(() => {
				const drag = dragRef.current;
				dragRef.current = null;
				setDragging(null);
				setGhost(null);
				if (drag !== null) {
					try {
						drag.element.releasePointerCapture(drag.pointerId);
					} catch (error) {
						/* already released */
					}
				}
			}, []);

			/* ── context menu ────────────────────────────────────────────── */

			useEffect(() => {
				if (menu === null) return undefined;
				const dismiss = (event) => {
					const node = menuRef.current;
					if (node !== null && event.target instanceof Node && node.contains(event.target)) return;
					setMenu(null);
				};
				const onKey = (event) => {
					if (event.key === 'Escape') setMenu(null);
				};
				const onBlur = () => setMenu(null);
				window.addEventListener('pointerdown', dismiss, true);
				window.addEventListener('keydown', onKey);
				window.addEventListener('blur', onBlur);
				return () => {
					window.removeEventListener('pointerdown', dismiss, true);
					window.removeEventListener('keydown', onKey);
					window.removeEventListener('blur', onBlur);
				};
			}, [menu]);

			/* ── render ──────────────────────────────────────────────────── */

			const tabs = snapshot.tabs;
			const rows = tabs.map((sessionId) => {
				const row = list.byId[sessionId];
				const active = snapshot.active === sessionId;
				const title = row === undefined ? t('tab.untitled') : row.displayTitle;
				const tooltip = row === undefined
					? t('error.session')
					: [row.displayTitle, row.cwd, row.running ? t('tab.running') : row.completed ? t('tab.done') : null]
						.filter((part) => typeof part === 'string' && part.length > 0)
						.join('\n');
				return e('div', {
					key: sessionId,
					className: 'dsh-tabs__tab',
					role: 'tab',
					'aria-selected': active,
					tabIndex: active ? 0 : -1,
					'data-tab-id': sessionId,
					'data-active': active ? '' : undefined,
					'data-running': row !== undefined && row.running ? '' : undefined,
					'data-done': row !== undefined && !row.running && row.completed === true ? '' : undefined,
					'data-drag': dragging === sessionId ? '' : undefined,
					title: tooltip,
					onPointerDown: (event) => onTabPointerDown(event, sessionId),
					onPointerMove: onTabPointerMove,
					onPointerUp: onTabPointerUp,
					onPointerCancel: onTabPointerCancel,
					onLostPointerCapture: onTabPointerCancel,
					onKeyDown: (event) => {
						/* The keyboard path a browser tab strip has: Enter/Space
						 * activate, Delete closes. */
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							store.activate(sessionId);
							openSession(sessionId);
							return;
						}
						if (event.key === 'Delete' || event.key === 'Backspace') {
							event.preventDefault();
							closeTab(sessionId);
						}
					},
					onAuxClick: (event) => {
						if (event.button !== 1) return;
						event.preventDefault();
						closeTab(sessionId);
					},
					onContextMenu: (event) => {
						event.preventDefault();
						store.activate(sessionId);
						setMenu({ sessionId, x: event.clientX, y: event.clientY });
					},
				},
				e('span', { className: 'dsh-tabs__dot', 'aria-hidden': 'true' }),
				e('span', { className: 'dsh-tabs__title' }, title),
				e('button', {
					type: 'button',
					className: 'dsh-tabs__close',
					title: t('tab.close'),
					'aria-label': t('tab.close'),
					onClick: (event) => {
						event.stopPropagation();
						closeTab(sessionId);
					},
				}, '\u00d7'));
			});

			/* The New Session square is as tall as the caption band allows and as wide
			 * as it is tall; the gap before it and after it are equal, so the empty
			 * part of the row left of the tabs stays a square of the row's height. */
			const newSide = Math.max(20, caption.height - 2 * CAPTION_LEFT_GAP);

			return e('div', {
				className: 'dsh-tabs',
				ref: barRef,
				'data-dsh-tabs': 'bar',
				'data-titlebar': captionRow ? '' : undefined,
				/* The native buttons sit in the caption band beside the tabs: keep
				 * their column empty on the right, and open the row on the left. */
				style: captionRow
					? {
						paddingLeft: caption.left + CAPTION_LEFT_GAP + 'px',
						paddingRight: caption.right + 8 + 'px',
					}
					: undefined,
			},
			e('button', {
				type: 'button',
				className: 'dsh-tabs__new',
				style: {
					width: newSide + 'px',
					height: newSide + 'px',
					marginRight: CAPTION_LEFT_GAP + 'px',
				},
				title: t('new.session'),
				'aria-label': t('new.session'),
				disabled: creating || undefined,
				onClick: onNewSession,
			}, newSessionIcon(16)),
			e('div', { className: 'dsh-tabs__strip', ref: stripRef, role: 'tablist' }, rows),
			captionRow ? e('div', { className: 'dsh-tabs__fill', 'aria-hidden': 'true' }) : null,
				toast === null ? null : e('div', { className: 'dsh-tabs__toast' }, toast),
				ghost === null ? null : e('div', {
					className: 'dsh-tabs__ghost',
					style: { left: ghost.x + 'px', top: ghost.y + 'px' },
				},
				e('span', { className: 'dsh-tabs__ghostTitle' }, ghost.title),
				ghost.outside ? e('span', { className: 'dsh-tabs__ghostHint' }, t('drop.detach')) : null),
				menu === null ? null : e('div', {
					className: 'dsh-tabs__menu',
					ref: menuRef,
					style: {
						left: Math.min(menu.x, Math.max(0, window.innerWidth - 240)) + 'px',
						top: Math.min(menu.y, Math.max(0, window.innerHeight - 140)) + 'px',
					},
				},
				e('button', {
					type: 'button',
					className: 'dsh-tabs__menuItem',
					onClick: () => {
						const target = menu.sessionId;
						setMenu(null);
						detachTab(target, { x: 80, y: 80, width: DETACH_WIDTH, height: DETACH_HEIGHT });
					},
				}, t('menu.detach')),
				e('button', {
					type: 'button',
					className: 'dsh-tabs__menuItem',
					onClick: () => {
						const target = menu.sessionId;
						setMenu(null);
						closeTab(target);
					},
				}, t('menu.close')),
				e('button', {
					type: 'button',
					className: 'dsh-tabs__menuItem',
					onClick: () => {
						const keep = menu.sessionId;
						setMenu(null);
						settle(store.closeOthers(keep));
					},
				}, t('tab.closeOthers')),
				e('button', {
					type: 'button',
					className: 'dsh-tabs__menuItem',
					onClick: () => {
						setMenu(null);
						settle(store.closeOthers(null));
					},
				}, t('tab.closeAll'))));
		}

		/* ════════════════════════════════════════════════════════════════════
		 *  7. PLUGIN BODY
		 * ════════════════════════════════════════════════════════════════════ */

		/**
		 * Services this half needs before it may register anything.
		 *
		 * 0.2.0 moved Session selection out of the Session Controller list into
		 * Workspace navigation, so `uiWorkspace` is required: without it the strip
		 * has no way to learn which Session the app is showing, nor to switch.
		 */
		const inject = ['slots', 'locale', 'layout', 'sessions', 'uiWorkspace'];

		/** The one store of this page; created at apply time, read by the strip. */
		let store = null;
		/** The Workspace navigation service (0.2.0): current Session + navigation. */
		let navigation = null;
		/** The durable selection source `{ sessionId?, subagentAddress? }`. */
		let selectionSource = null;

		/**
		 * Read the Session the app currently shows.
		 *
		 * 0.2.0 keeps this in the Workspace navigation selection (`dsh.sessions.current`
		 * in browser storage) instead of the removed `sessions.list.current`. Reading
		 * it never throws outward: a composition without the service leaves the strip
		 * with no current Session rather than killing the render.
		 *
		 * @returns the selected Session id, or undefined when the view is cleared.
		 */
		function currentSessionId() {
			if (selectionSource === null) return undefined;
			try {
				const value = selectionSource.getSnapshot();
				return value === null || value === undefined ? undefined : value.sessionId;
			} catch (error) {
				return undefined;
			}
		}

		/** Stable uSES subscribe for the selection source. */
		function subscribeSelection(listener) {
			if (selectionSource === null) return () => {};
			return selectionSource.subscribe(listener);
		}

		/**
		 * Register the strip and the frame reservation.
		 *
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			try {
				ctx.effect(() => ctx.locale.register(NS, { en, ru }), 'dsh-session-tabs: dictionaries');

				const t = ctx.locale.bind(NS);
				store = createTabStore(ctx);
				navigation = ctx.uiWorkspace;
				selectionSource = navigation !== null && navigation !== undefined && navigation.selection !== undefined
					? navigation.selection
					: null;
				injectCss();

				/* `shell.overlay` is a list seat: this entry sits beside whatever
				 * else floats over the frame, and only the strip itself takes
				 * pointer events. */
				ctx.slots.inject('shell.overlay', () => ctx.slots.register({
					name: 'shell.overlay',
					id: 'session-tabs',
					order: -100,
					locale: NS,
				}, (props) => SessionTabs({ ...props, ctx, t })));

				/* Release the frame reservation when this plugin unloads. */
				ctx.effect(() => () => {
					const overlay = document.querySelector('[data-shell-overlay]');
					const frame = overlay === null ? null : overlay.parentElement;
					if (frame === null) return;
					frame.removeAttribute(FRAME_ATTR);
					frame.style.removeProperty('--dsh-session-tabs-h');
				}, 'dsh-session-tabs: frame reservation');
			} catch (error) {
				ctx.logger.error('dsh-session-tabs: mount failed', error);
			}
		}

		exports.name = 'dsh-session-tabs';
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
