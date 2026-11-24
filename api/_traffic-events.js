'use strict';

const MAX_SITE_STREAMS = 400;
const MAX_PEER_STREAMS = 12;
const PUBLISH_DELAY_MS = 120;
const PING_INTERVAL_MS = 10_000;
const frame = stats => `data: ${JSON.stringify(stats)}\n\n`;

function createTrafficEvents({ traffic, peer }) {
  const local = { clients: new Map(), max: MAX_PEER_STREAMS };
  const combined = { clients: new Map(), max: MAX_SITE_STREAMS };
  let updateTimer;
  let clock;
  let writing = false;
  let pending = false;
  let lastPing = Date.now();

  const hasObservers = () => local.clients.size + combined.clients.size > 0;

  function schedule() {
    if (!hasObservers()) return;
    if (writing) {
      pending = true;
      return;
    }
    if (updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      void broadcast();
    }, PUBLISH_DELAY_MS);
    updateTimer.unref();
  }

  function publish(group, data, ping) {
    for (const [res, previous] of group.clients) {
      if (res.destroyed || res.writableEnded || res.writableLength > 4096) {
        group.clients.delete(res);
        res.destroy();
        continue;
      }
      if (data && (data !== previous || (ping && group === local))) {
        res.write(data);
        group.clients.set(res, data);
      } else if (ping) {
        res.write(': keepalive\n\n');
      }
    }
  }

  async function broadcast() {
    if (!hasObservers()) return;
    writing = true;
    try {
      const stats = await traffic.readSnapshot({ local: true });
      const ping = Date.now() - lastPing >= PING_INTERVAL_MS;
      if (ping) lastPing = Date.now();
      if (local.clients.size) publish(local, frame(stats), ping);
      if (combined.clients.size) {
        publish(combined, frame({ ...traffic.combineSnapshot(stats), ...traffic.describe(false) }), ping);
      }
    } catch {
      // Waiting for a snapshot would leave the client with an apparently healthy connection.
      for (const group of [local, combined]) for (const res of group.clients.keys()) res.destroy();
    } finally {
      writing = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  }

  function stopClock() {
    clearInterval(clock);
    clearTimeout(updateTimer);
    clock = updateTimer = undefined;
  }

  function open(res, raw) {
    const group = raw ? local : combined;
    if (group.clients.size >= group.max) {
      res.writeHead(503, { 'Cache-Control': 'no-store', 'Retry-After': '20' });
      res.end('Traffic stream busy');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      'X-Traffic-Scope': traffic.describe(raw).scope,
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    group.clients.set(res, null);
    res.on('close', () => {
      group.clients.delete(res);
      if (!hasObservers()) stopClock();
    });
    if (!clock) {
      lastPing = Date.now();
      clock = setInterval(schedule, 1000);
      clock.unref();
    }
    schedule();
  }

  const unsubscribeLocal = traffic.subscribe(schedule);
  const unsubscribePeer = peer?.subscribe?.(schedule);
  function close() {
    stopClock();
    unsubscribeLocal();
    unsubscribePeer?.();
    for (const group of [local, combined]) {
      for (const res of group.clients.keys()) res.destroy();
      group.clients.clear();
    }
  }
  return { open, close };
}

module.exports = { createTrafficEvents };
