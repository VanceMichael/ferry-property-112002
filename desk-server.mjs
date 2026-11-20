// 归集核验台：在来源服务之上持续收集记录，提供服务台与保管台两路查询。
// 默认来源 http://127.0.0.1:4100（npm start 启动的回放来源），可用 SOURCE_URL 覆盖；
// 本服务默认监听 127.0.0.1:4200，可用 DESK_PORT 覆盖。

import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createProjection } from './desk-core.mjs';
import { createCollector } from './desk-collector.mjs';
import { sendJson } from './source-server.mjs';

export async function startDesk({
  port = 0,
  host = '127.0.0.1',
  sourceUrl = process.env.SOURCE_URL ?? 'http://127.0.0.1:4100',
  intervalMs = 1000,
  poll = true,
} = {}) {
  const projection = createProjection();
  const collector = createCollector({ baseUrl: sourceUrl, projection });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/poll' && request.method === 'POST') {
        sendJson(response, 200, await collector.pollOnce());
        return;
      }
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: '仅支持读取与手动轮询' });
        return;
      }
      if (url.pathname === '/') {
        sendJson(response, 200, {
          service: '遗留物归集核验台',
          source: sourceUrl,
          stats: collector.stats,
          overview: projection.overview(),
        });
        return;
      }
      if (url.pathname === '/desk/claims') {
        sendJson(response, 200, projection.claimViews());
        return;
      }
      // 台面只显示可公开范围：不含私下核验特征
      if (url.pathname === '/desk/public/claims') {
        sendJson(response, 200, projection.publicClaimViews());
        return;
      }
      const claimMatch = /^\/desk\/claims\/([^/]+)$/.exec(url.pathname);
      if (claimMatch) {
        const view = projection.claimViews().find((item) => item.claim === decodeURIComponent(claimMatch[1]));
        if (view) sendJson(response, 200, view);
        else sendJson(response, 404, { error: '未找到登记' });
        return;
      }
      if (url.pathname === '/desk/objects') {
        sendJson(response, 200, projection.objectViews());
        return;
      }
      if (url.pathname === '/desk/supplements') {
        sendJson(response, 200, projection.supplements());
        return;
      }
      if (url.pathname === '/custody/objects') {
        sendJson(response, 200, projection.custodyObjectViews());
        return;
      }
      if (url.pathname === '/custody/bags') {
        sendJson(response, 200, projection.custodyBagViews());
        return;
      }
      if (url.pathname === '/events') {
        sendJson(response, 200, projection.state.events);
        return;
      }
      sendJson(response, 404, { error: '未找到接口' });
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: '归集服务失败' });
      else response.destroy();
    }
  });
  server.listen(port, host);
  await once(server, 'listening');
  if (poll) {
    await collector.pollOnce();
    collector.start(intervalMs);
  }
  return { server, url: `http://${host}:${server.address().port}`, projection, collector };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const app = await startDesk({ port: Number(process.env.DESK_PORT ?? 4200) });
  console.log(`归集核验台 ${app.url} ，来源 ${process.env.SOURCE_URL ?? 'http://127.0.0.1:4100'}`);
}
