// Isolated UI acceptance only: disposable account, simulation, and local AI replies.
// No production credentials, keys, or simulation are loaded.
import http from 'node:http';
import {createAdminServer} from '../admin-access/server.mjs';
import {IsolatedAdminAuth} from '../admin-access/tests/isolated-auth.mjs';
import {SharedSimulation} from '../traffic-sandbox/shared-simulation.mjs';
import {createSandboxServer} from '../traffic-sandbox/server.mjs';
import {createLabServer} from '../dify-integration-lab/server.mjs';
import {createSandboxClient} from '../dify-integration-lab/sandbox-client.mjs';
const servers = [];
async function listen(server, port = 0) {
  servers.push(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return 'http://127.0.0.1:' + server.address().port;
}
const runtime = new SharedSimulation({running: false, settings: {northBypassShare: 60}});
runtime.sim.step(360);
const bridgeKey = 'site-motion-fixture-only';
const sandboxBase = await listen(createSandboxServer({runtime, clock: false, controlKey: bridgeKey}));
const auth = new IsolatedAdminAuth(); await auth.setup('motion_test', 'only-local-motion-test');
const model = async (_, payload) => {
  const input = JSON.parse(payload.query);
  await new Promise(resolve => setTimeout(resolve, 350));
  return {answer: JSON.stringify({protocol: 'campus-admin-v2', status: 'ok', intent: 'suggest',
    state_version: input.state.stateVersion, reply: '建议比较北侧绕行策略目标。此处为独立动效测试回复。',
    basis: input.state.behavior?.enabled ? '本次参考了路线认知、尝试意愿和引导触达；{{behavior.facts.eligible}}。' : '当前未启用认知与意愿分组，本次仍按原选路规则分析',
    changes: {}, suggested_settings: {northBypassShare: 80},
    evidence: input.state.behavior?.enabled ? ['behavior.facts.eligible'] : ['settings.northBypassShare']}),
    conversationId: 'motion-fixture'};
};
const adminBase = await listen(createAdminServer({auth, bridgeKey, sandboxPort: Number(new URL(sandboxBase).port), port: 0,
  aiConfigProvider: async () => ({apiKey: 'motion-fixture-only'}), aiModel: model}));
const upstreamBase = await listen(http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const input = JSON.parse(JSON.parse(raw).query), criterion = input.question.includes('近') ? 'distance' : input.preference;
  const field = criterion === 'time' ? 'travelTimeSeconds' : 'distanceMeters';
  const best = [...input.state.routes].sort((a,b) => a[field] - b[field])[0];
  await new Promise(resolve => setTimeout(resolve, 350));
  res.writeHead(200, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({answer: JSON.stringify({status: 'ok', criterion, recommended_route_id: best.id}), conversation_id: 'motion-student'}));
}));
const studentBase = await listen(createLabServer(async () => ({apiBase: upstreamBase + '/v1', apiKey: 'motion-student-only', allowLoopback: true}),
  {studentProvider: createSandboxClient({base: sandboxBase})}));
const mediaScript = `const originalMedia=window.matchMedia.bind(window);window.matchMedia=query=>query.includes('prefers-reduced-motion')?{media:query,matches:true,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}:originalMedia(query);document.documentElement.setAttribute('data-fixture-reduced-motion',String(window.matchMedia('(prefers-reduced-motion: reduce)').matches));`;
function proxy(base) {
  const target = new URL(base);
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/fixture-media.mjs') {
      res.writeHead(200, {'Content-Type': 'text/javascript', 'Cache-Control': 'no-store'}); res.end(mediaScript); return;
    }
    const headers = {...req.headers, host: target.host};
    if (headers.origin) headers.origin = target.origin;
    const upstream = http.request({hostname: '127.0.0.1', port: target.port, path: req.url, method: req.method, headers}, reply => {
      const chunks = []; reply.on('data', chunk => chunks.push(chunk)); reply.on('end', () => {
        let body = Buffer.concat(chunks), type = reply.headers['content-type'] || '';
        if (url.searchParams.has('reduced') && type.includes('text/html')) {
          let html = body.toString().replace('</head>', '<script src="/fixture-media.mjs"></script></head>');
          html = html.replace(/href="([^"]+\.css)"/g, 'href="$1?reduced=1"'); body = Buffer.from(html);
        }
        if (url.searchParams.has('reduced') && type.includes('text/css')) body = Buffer.from(body.toString().replace(/\(prefers-reduced-motion:\s*reduce\)/g, '(min-width:0px)'));
        const outputHeaders = {...reply.headers}; delete outputHeaders['content-length']; delete outputHeaders['transfer-encoding'];
        res.writeHead(reply.statusCode, outputHeaders); res.end(body);
      });
    });
    upstream.on('error', () => {res.writeHead(502); res.end('Fixture upstream unavailable');}); req.pipe(upstream);
  });
}
await listen(proxy(adminBase), 4194); await listen(proxy(studentBase), 4195);
console.log('Isolated motion fixture: admin http://127.0.0.1:4194/login; student http://127.0.0.1:4195/student/');
const stop = () => { for (const server of servers) { server.closeAllConnections(); server.close(); } };
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, stop);
setTimeout(stop, 45 * 60 * 1000).unref();
