/** Fixed QUIN-50 workload. Pass Browser plugin tab/CDP handles, node:fs/promises,
* an array for samples, and a private outputDir containing harness-LABEL60.jsonl.
* Warm the runner once and install observe-conversation-latency.js first.
* The active full-panel DM is Probe Alpha; viewport is 2560 x 1295.
*/
export function browserWorkload({ latencyCdp, latencyTab, fs, samples, outputDir }) {
  const fixedBrowserSamples = samples;
  return async function fixedBrowserBatch(n, label) {
    for (let i = 0; i < n; i++) {
      await latencyCdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1300, y: 900, deltaX: 0, deltaY: 10000 });
      await new Promise(r => setTimeout(r, 500));
      await latencyTab.playwright.getByRole('textbox', { name: 'Message Probe Alpha', exact: true }).fill('Hello. Reply with a short greeting.');
      await latencyTab.playwright.getByRole('textbox', { name: 'Message Probe Alpha', exact: true }).press('Enter');
      const deadline = Date.now() + 10000;
      let sample;
      do {
        const r = await latencyCdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.quintalLatency.samples().records.at(-1))', returnByValue: true });
        sample = JSON.parse(r.result.value);
        if (sample.outcome === 'completed' && sample.answerCandidateMs !== null)
          break;
        await new Promise(r => setTimeout(r, 200));
      } while (Date.now() < deadline);
      const check = await latencyCdp.send('Runtime.evaluate', { expression: 'JSON.stringify([...document.querySelectorAll("[data-request-id]")].filter(s=>s.dataset.requestId===' + JSON.stringify(sample.requestId) + ').some(s=>[...s.querySelectorAll("[data-activity-message]")].some(m=>m.dataset.messageId===s.dataset.finalMessageId && /^(hello|hi|hey)\\b/i.test(m.textContent.trim()) && m.textContent.length<200)))', returnByValue: true });
      sample.answerVerified = JSON.parse(check.result.value);
      sample.deadlineOutcome = sample.outcome === 'completed' && sample.answerCandidateMs !== null && sample.answerCandidateMs <= 10000 && sample.answerVerified ? 'success' : 'timeout-or-unverified';
      sample.label = label;
      fixedBrowserSamples.push(sample);
      await fs.writeFile(outputDir + '/fixed-real-dom.json', JSON.stringify(fixedBrowserSamples, null, 2));
      const runtimeDeadline = Date.now() + 60000;
      while (true) {
        const lines = (await fs.readFile(outputDir + '/harness-' + label + '60.jsonl', 'utf8')).trim().split('\n').map(l => JSON.parse(l));
        if (lines.some(s => s.requestId === sample.requestId && s.outcome !== 'retry'))
          break;
        if (Date.now() > runtimeDeadline)
          throw new Error('Runtime did not settle after browser deadline');
        await new Promise(r => setTimeout(r, 200));
      }
      await new Promise(r => setTimeout(r, 1200));
    }
    console.log({ label, attempted: fixedBrowserSamples.filter(s => s.label === label).length, successful: fixedBrowserSamples.filter(s => s.label === label && s.deadlineOutcome === 'success').length });
  };
}
