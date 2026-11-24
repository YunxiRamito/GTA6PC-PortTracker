(() => {
  'use strict';

  const board = document.getElementById('trafficBoard');
  if (!board) return;
  const format = new Intl.NumberFormat(document.documentElement.lang || undefined);
  fetch('/api/traffic', { signal: AbortSignal.timeout(5000) })
    .then(response => {
      if (!response.ok) throw new Error('Traffic fixture unavailable');
      return response.json();
    })
    .then(({ online, totalVisits }) => {
      document.getElementById('onlineCompactCount').textContent = format.format(online);
      document.getElementById('onlineCount').textContent = format.format(online);
      document.getElementById('totalVisitCount').textContent = format.format(totalVisits);
      board.dataset.state = 'live';
    })
    .catch(() => { board.dataset.state = 'offline'; });

  document.addEventListener('pointerdown', event => {
    if (board.open && !board.contains(event.target)) board.open = false;
  });
  board.addEventListener('keydown', event => {
    if (event.key === 'Escape' && board.open) {
      board.open = false;
      board.querySelector('summary')?.focus();
    }
  });
})();
