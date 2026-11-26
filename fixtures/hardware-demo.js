'use strict';

// Fictional values with the site's hardware-check API shape. The source URL is
// a reference to the original tool, not the origin of these demo values.
module.exports = {
  source: 'https://gta6recomp.com/can-i-run',
  syncedAt: '2026-01-01T00:00:00.000Z',
  stale: false,
  gpus: [
    { name: 'Demo GPU A', score: 37, vramGb: 5 },
    { name: 'Demo GPU B', score: 72, vramGb: 11 },
    { name: 'Demo GPU C', score: 94, vramGb: 19 },
  ],
  cpus: [
    { name: 'Demo CPU A', score: 41 },
    { name: 'Demo CPU B', score: 68 },
    { name: 'Demo CPU C', score: 105 },
  ],
  targets: [
    { id: 'demo-basic', label: '示例 · 基础档', gpuScore: 36, cpuScore: 40, ramGb: 12, vramGb: 5 },
    { id: 'demo-plus', label: '示例 · 进阶档', gpuScore: 75, cpuScore: 70, ramGb: 24, vramGb: 11 },
  ],
  storage: [
    { id: 'demo-drive-a', label: '示例储存 A', score: 0.4 },
    { id: 'demo-drive-b', label: '示例储存 B', score: 1 },
    { id: 'demo-drive-c', label: '示例储存 C', score: 1.8 },
  ],
};
