import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveWorkspaceDatabase as resolveWorkspaceDatabaseMock } from './db.js';
import { createDbWatcher, watchViaPolling } from './poll-watcher.js';
import { watchDb as watchDbMock } from './watcher.js';

vi.mock('./db.js', () => ({
  resolveWorkspaceDatabase: vi.fn()
}));

vi.mock('./watcher.js', () => ({
  watchDb: vi.fn(() => ({
    close: vi.fn(),
    rebind: vi.fn(),
    path: 'sqlite-sentinel'
  }))
}));

const resolveWorkspaceDatabase = /** @type {import('vitest').Mock} */ (
  resolveWorkspaceDatabaseMock
);
const watchDb = /** @type {import('vitest').Mock} */ (watchDbMock);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resolveWorkspaceDatabase.mockReturnValue({
    path: '/repo/.beads',
    source: 'metadata',
    exists: true
  });
});

afterEach(() => {
  delete process.env.BDUI_POLL_INTERVAL_MS;
  vi.useRealTimers();
});

describe('watchViaPolling', () => {
  test('fires onChange once per interval, across multiple ticks', () => {
    const calls = [];
    const handle = watchViaPolling('/repo', () => calls.push(null));

    expect(calls.length).toBe(0);
    vi.advanceTimersByTime(2500);
    expect(calls.length).toBe(1);
    vi.advanceTimersByTime(2500);
    expect(calls.length).toBe(2);

    handle.close();
  });

  test('stops firing after close()', () => {
    const calls = [];
    const handle = watchViaPolling('/repo', () => calls.push(null));

    vi.advanceTimersByTime(2500);
    expect(calls.length).toBe(1);

    handle.close();
    vi.advanceTimersByTime(10000);
    expect(calls.length).toBe(1);
  });

  test('exposes the resolved path via the .path getter', () => {
    resolveWorkspaceDatabase.mockReturnValue({
      path: '/repo/.beads/ui.db',
      source: 'nearest',
      exists: true
    });
    const handle = watchViaPolling('/repo', () => {});
    expect(handle.path).toBe('/repo/.beads/ui.db');
    handle.close();
  });

  test('rebind re-resolves via resolveWorkspaceDatabase and updates .path', () => {
    resolveWorkspaceDatabase.mockReturnValueOnce({
      path: '/repo/.beads',
      source: 'metadata',
      exists: true
    });
    const handle = watchViaPolling('/repo', () => {});
    expect(handle.path).toBe('/repo/.beads');
    expect(resolveWorkspaceDatabase).toHaveBeenCalledWith({
      cwd: '/repo',
      explicit_db: undefined
    });

    resolveWorkspaceDatabase.mockReturnValueOnce({
      path: '/other/.beads',
      source: 'metadata',
      exists: true
    });
    handle.rebind({ root_dir: '/other' });

    expect(handle.path).toBe('/other/.beads');
    expect(resolveWorkspaceDatabase).toHaveBeenLastCalledWith({
      cwd: '/other',
      explicit_db: undefined
    });

    handle.close();
  });

  test('rebind honors an updated explicit_db', () => {
    const handle = watchViaPolling('/repo', () => {}, {
      explicit_db: '/repo/first'
    });
    handle.rebind({ explicit_db: '/repo/second' });
    expect(resolveWorkspaceDatabase).toHaveBeenLastCalledWith({
      cwd: '/repo',
      explicit_db: '/repo/second'
    });
    handle.close();
  });

  test('unrefs the polling timer', () => {
    const unref = vi.fn();
    const fake_timer = { unref, ref: vi.fn() };
    const spy = vi
      .spyOn(global, 'setInterval')
      .mockReturnValue(/** @type {any} */ (fake_timer));

    const handle = watchViaPolling('/repo', () => {}, { interval_ms: 1000 });

    expect(unref).toHaveBeenCalledTimes(1);

    handle.close();
    spy.mockRestore();
  });

  test('interval is overridable via options.interval_ms', () => {
    const calls = [];
    const handle = watchViaPolling('/repo', () => calls.push(null), {
      interval_ms: 500
    });

    vi.advanceTimersByTime(499);
    expect(calls.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(calls.length).toBe(1);

    handle.close();
  });

  test('interval is overridable via BDUI_POLL_INTERVAL_MS env var', () => {
    process.env.BDUI_POLL_INTERVAL_MS = '1000';
    const calls = [];
    const handle = watchViaPolling('/repo', () => calls.push(null));

    vi.advanceTimersByTime(999);
    expect(calls.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(calls.length).toBe(1);

    handle.close();
  });

  test('options.interval_ms wins over the env var', () => {
    process.env.BDUI_POLL_INTERVAL_MS = '1000';
    const calls = [];
    const handle = watchViaPolling('/repo', () => calls.push(null), {
      interval_ms: 300
    });

    vi.advanceTimersByTime(300);
    expect(calls.length).toBe(1);

    handle.close();
  });

  test('invalid options.interval_ms and env var fall back to the 2500 ms default', () => {
    process.env.BDUI_POLL_INTERVAL_MS = 'not-a-number';
    const calls = [];
    const handle = watchViaPolling('/repo', () => calls.push(null), {
      interval_ms: -5
    });

    vi.advanceTimersByTime(2499);
    expect(calls.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(calls.length).toBe(1);

    handle.close();
  });

  test('invalid env var alone falls back to the 2500 ms default', () => {
    process.env.BDUI_POLL_INTERVAL_MS = '0';
    const calls = [];
    const handle = watchViaPolling('/repo', () => calls.push(null));

    vi.advanceTimersByTime(2500);
    expect(calls.length).toBe(1);

    handle.close();
  });
});

describe('createDbWatcher', () => {
  test('selects the polling watcher for a Dolt/server (metadata) workspace', () => {
    resolveWorkspaceDatabase.mockReturnValue({
      path: '/repo/.beads',
      source: 'metadata',
      exists: true
    });

    const calls = [];
    const handle = createDbWatcher('/repo', () => calls.push(null));

    expect(watchDb).not.toHaveBeenCalled();
    expect(handle.path).toBe('/repo/.beads');

    // Polling behavior: onChange fires on the interval, not via fs.watch.
    vi.advanceTimersByTime(2500);
    expect(calls.length).toBe(1);

    handle.close();
  });

  test('selects the fs.watch-based watchDb watcher for a SQLite .db file target', () => {
    resolveWorkspaceDatabase.mockReturnValue({
      path: '/repo/.beads/ui.db',
      source: 'nearest',
      exists: true
    });

    const handle = createDbWatcher('/repo', () => {});

    expect(watchDb).toHaveBeenCalledTimes(1);
    expect(watchDb).toHaveBeenCalledWith('/repo', expect.any(Function), {});
    expect(handle.path).toBe('sqlite-sentinel');
  });

  test('passes options through to the selected watcher', () => {
    resolveWorkspaceDatabase.mockReturnValue({
      path: '/repo/.beads/ui.db',
      source: 'nearest',
      exists: true
    });
    const options = { debounce_ms: 10, explicit_db: '/repo/.beads/ui.db' };

    createDbWatcher('/repo', () => {}, options);

    expect(watchDb).toHaveBeenCalledWith(
      '/repo',
      expect.any(Function),
      options
    );
  });
});
