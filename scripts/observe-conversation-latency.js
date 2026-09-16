/** Install in a local test office through DevTools. No chat text or credentials are retained.
 * Read window.quintalLatency.samples(), then call window.quintalLatency.stop().
 */
(() => {
  window.quintalLatency?.stop();
  const records = new Map();
  let frame = 0;
  let evicted = 0;
  const visible = element => {
    if (document.hidden || !element.getClientRects().length) return false;
    const rect = element.getBoundingClientRect();
    let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
    let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    for (let parent = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      if (parent === element) continue;
      const bounds = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
      }
    }
    if (right <= left || bottom <= top) return false;
    // A mounted compact transcript behind the conversation dialog is not visible feedback.
    const front = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return front !== null && (element.contains(front) || front.contains(element));
  };
  function scan() {
    frame = 0;
    const now = performance.now();
    for (const section of document.querySelectorAll('[data-request-id][data-turn-id]')) {
      const matching = (section.dataset.requestIds || section.dataset.requestId).split(' ')
        .map(id => records.get(id)).filter(Boolean);
      if (!matching.length) continue;
      if (!visible(section)) continue;
      for (const record of matching) {
        record.turnId ??= section.dataset.turnId;
        record.feedbackMs ??= now - record.sentAt;
        const messages = [...section.querySelectorAll('[data-activity-message]')].filter(visible);
        if (messages.length) record.replyMs ??= now - record.sentAt;
        for (const message of messages) {
          if (record.messages.length < 64 && !record.messages.some(m => m.id === message.dataset.messageId))
            record.messages.push({ id: message.dataset.messageId, firstVisibleMs: now - record.sentAt });
        }
        const state = section.dataset.activityState;
        if (['completed', 'failed', 'cancelled', 'interrupted', 'disconnected'].includes(state)) {
          record.deliveryMs ??= now - record.sentAt;
          record.outcome = state;
          record.answerCandidateMs = record.messages.find(m => m.id === section.dataset.finalMessageId)?.firstVisibleMs ?? null;
        }
      }
    }
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(scan); }
  function sent(event) {
    const { requestId, at } = event.detail ?? {};
    if (typeof requestId !== 'string' || requestId.length !== 36 || !Number.isFinite(at)) return;
    if (records.size >= 512) { records.delete(records.keys().next().value); evicted++; }
    records.set(requestId, { requestId, sentAt: at, turnId: null, feedbackMs: null, replyMs: null, deliveryMs: null, answerCandidateMs: null, messages: [], outcome: 'pending' });
    schedule();
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  window.addEventListener('quintal:human-send', sent);
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  document.addEventListener('visibilitychange', schedule);
  window.quintalLatency = {
    samples: () => ({ version: 1, clock: 'browser performance.now', boundary: 'visible DOM at animation frame', evicted, records: [...records.values()] }),
    stop: () => {
      observer.disconnect();
      window.removeEventListener('quintal:human-send', sent);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', schedule);
      if (frame) cancelAnimationFrame(frame);
      delete window.quintalLatency;
    },
  };
})();
