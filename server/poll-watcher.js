import fs from 'node:fs';
import { resolveWorkspaceDatabase } from './db.js';
import { debug } from './logging.js';
import { watchDb } from './watcher.js';

/** Default polling interval, in milliseconds, used when no override is set. */
const DEFAULT_INTERVAL_MS = 2500;

/**
 * Watch the resolved workspace database target by polling on a fixed
 * interval, invoking a callback on every tick.
 *
 * This is used for backends (for example Dolt/server workspaces) where the
 * resolved target is not a single file that `fs.watch` can meaningfully
 * observe. Callers are expected to treat each tick as "check for changes"
 * rather than as evidence that something actually changed.
 *
 * @param {string} root_dir - Project root directory (starting point for resolution).
 * @param {() => void} onChange - Called on every poll tick.
 * @param {{ interval_ms?: number, explicit_db?: string }} [options]
 * @returns {{ close: () => void, rebind: (opts?: { root_dir?: string, explicit_db?: string }) => void, path: string }}
 */
export function watchViaPolling(root_dir, onChange, options = {}) {
  const interval_ms = resolveIntervalMs(options.interval_ms);
  const log = debug('poll-watcher');

  let current_root = root_dir;
  let current_explicit = options.explicit_db;
  let current_path = '';

  /**
   * Re-resolve the workspace database path for the current root/explicit_db.
   *
   * @param {string} base_dir
   * @param {string | undefined} explicit_db
   */
  const resolve = (base_dir, explicit_db) => {
    const resolved = resolveWorkspaceDatabase({
      cwd: base_dir,
      explicit_db
    });
    current_path = resolved.path;
    if (!resolved.exists) {
      log(
        'resolved workspace database missing: %s – Hint: set --db, export BEADS_DB, or run `bd init` in your workspace.',
        current_path
      );
    }
  };

  resolve(current_root, current_explicit);

  const timer = setInterval(() => {
    log('poll tick %s', current_path);
    onChange();
  }, interval_ms);
  timer.unref();

  return {
    get path() {
      return current_path;
    },
    close() {
      clearInterval(timer);
    },
    /**
     * Re-resolve when root_dir or explicit_db changes. The polling timer
     * keeps running on its existing interval; only the resolved path is
     * updated.
     *
     * @param {{ root_dir?: string, explicit_db?: string }} [opts]
     */
    rebind(opts = {}) {
      current_root = opts.root_dir ? String(opts.root_dir) : current_root;
      current_explicit = opts.explicit_db ?? current_explicit;
      resolve(current_root, current_explicit);
    }
  };
}

/**
 * Resolve the effective poll interval: `options.interval_ms` wins over the
 * `BDUI_POLL_INTERVAL_MS` env var, which wins over the default. Invalid
 * (non-numeric or non-positive) values fall back to the default.
 *
 * @param {number | undefined} option_value
 * @returns {number}
 */
function resolveIntervalMs(option_value) {
  const from_option = coercePositiveInt(option_value);
  if (from_option !== undefined) {
    return from_option;
  }
  const from_env = coercePositiveInt(process.env.BDUI_POLL_INTERVAL_MS);
  if (from_env !== undefined) {
    return from_env;
  }
  return DEFAULT_INTERVAL_MS;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function coercePositiveInt(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return n;
}

/**
 * Create a DB watcher, dispatching to a polling-based watcher for
 * non-SQLite (for example Dolt/server) workspaces and to the
 * `fs.watch`-based {@link watchDb} watcher for SQLite `.db` file targets.
 *
 * @param {string} root_dir - Project root directory (starting point for resolution).
 * @param {() => void} onChange - Called when changes are detected (or, for polling, on every tick).
 * @param {{ debounce_ms?: number, cooldown_ms?: number, interval_ms?: number, explicit_db?: string }} [options]
 * @returns {{ close: () => void, rebind: (opts?: { root_dir?: string, explicit_db?: string }) => void, path: string }}
 */
export function createDbWatcher(root_dir, onChange, options = {}) {
  const resolved = resolveWorkspaceDatabase({
    cwd: root_dir,
    explicit_db: options.explicit_db
  });
  if (resolved.source === 'metadata' || pathIsDirectory(resolved.path)) {
    return watchViaPolling(root_dir, onChange, options);
  }
  return watchDb(root_dir, onChange, options);
}

/**
 * @param {string} file_path
 */
function pathIsDirectory(file_path) {
  try {
    return fs.statSync(file_path).isDirectory();
  } catch {
    return false;
  }
}
