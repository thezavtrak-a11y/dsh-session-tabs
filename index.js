/**
 * dsh-session-tabs — host half.
 *
 * The feature is browser-only: the tab strip, its per-window state and the
 * tear-off gesture all live in `lib/client.js`, registering against the
 * official slot / locale / Session Controller faces of the web client.
 *
 * This Node half exists only so the loader can mount the package (through a
 * `cordis.patch.yml` insert row) and the client-modules scanner can find the
 * `dsh.client` declaration and serve the browser bundle at
 * `/plugins/dsh-session-tabs/client.js`.
 *
 * Nothing on the host is patched and no route is added.
 *
 * @module dsh-session-tabs
 */

/** Stable plugin name used by the cordis loader row. */
export const name = 'dsh-session-tabs'

/** No host-side service is needed; the row is a pure carrier for the client half. */
export function apply() {
  // Intentionally empty on the host side.
}
