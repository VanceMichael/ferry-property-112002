// 持续收集清舱终端、两岸保管台、寻物柜台的记录：
// - 三个来源按分页拉全量，以来源记录键去重，回放阶段推进后自动补收新记录；
// - 对存在有效保留的登记，按（保管点, 登记）追问柜台交出回执（202/200/404）；
// - 所有记录进入投影核心，视图随时可查。

import { createProjection } from './desk-core.mjs';

export const SOURCE_NAMES = ['cabin', 'storage', 'counters'];

export function createCollector({ baseUrl, projection = createProjection(), fetchImpl = globalThis.fetch, pageLimit = 100 }) {
  if (!baseUrl) throw new Error('需要来源地址 baseUrl');
  const seen = new Set();
  const stats = { polls: 0, ingested: 0, stage: null, lastError: null };
  let timer = null;

  const fetchJson = async (path) => {
    const response = await fetchImpl(`${baseUrl}${path}`);
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  };

  const pollSource = async (name) => {
    let offset = 0;
    for (;;) {
      const { status, body } = await fetchJson(`/source/${name}?offset=${offset}&limit=${pageLimit}`);
      if (status !== 200 || !body) throw new Error(`来源 ${name} 读取失败（${status}）`);
      stats.stage = body.stage;
      for (const entry of body.records) {
        const key = `${name}:${entry.record}`;
        if (seen.has(key)) continue;
        seen.add(key);
        projection.apply({ source: name, record: entry.record, kind: entry.kind, payload: entry.payload });
        stats.ingested += 1;
      }
      if (body.next === null) return;
      offset = body.next;
    }
  };

  const pollReceipts = async () => {
    for (const query of projection.receiptQueries()) {
      const path = `/counter-receipt?point=${encodeURIComponent(query.point)}&claim=${encodeURIComponent(query.claim)}`;
      const { status, body } = await fetchJson(path);
      const key = `receipt:${query.point}:${query.claim}:${status}:${body?.receipt ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      projection.apply({
        source: 'receipt',
        record: key,
        kind: 'receipt',
        payload: { point: query.point, claim: query.claim, status, body },
      });
      stats.ingested += 1;
    }
  };

  const pollOnce = async () => {
    try {
      for (const name of SOURCE_NAMES) await pollSource(name);
      await pollReceipts();
      stats.polls += 1;
      stats.lastError = null;
    } catch (error) {
      stats.lastError = String(error?.message ?? error);
    }
    return stats;
  };

  const start = (intervalMs = 1000) => {
    if (timer) return;
    timer = setInterval(() => { void pollOnce(); }, intervalMs);
    timer.unref?.();
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return { projection, stats, pollOnce, start, stop };
}
