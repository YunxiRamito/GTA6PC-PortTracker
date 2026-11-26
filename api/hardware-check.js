'use strict';

const hardwareDemo = require('../fixtures/hardware-demo');
const HARDWARE_CHECK_PATH = '/api/hardware-check';
const demoBody = JSON.stringify(hardwareDemo);

// Shared by the local site and read-only preview. Never reads or fetches data.
function serveHardwareCheck(req, res) {
  const isRead = req.method === 'GET';
  const body = isRead ? demoBody : '{"error":"Only GET is supported"}';
  res.writeHead(isRead ? 200 : 405, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...(isRead ? { 'X-GTAVI-Hardware-Data': 'synthetic' } : { Allow: 'GET', Connection: 'close' }),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

module.exports = { HARDWARE_CHECK_PATH, serveHardwareCheck };
