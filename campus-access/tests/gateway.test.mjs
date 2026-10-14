import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {gunzipSync} from 'node:zlib';
import {createCampusServer, allowedCampusAddress} from '../server.mjs';
import {createSandboxServer} from '../../traffic-sandbox/server.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
function request(port, path, {method = 'GET', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({hostname: '127.0.0.1', port, path, method,
      headers: {Host: '127.0.0.1:4180', ...headers}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject); req.end(body);
  });
}

test('campus ingress accepts only the configured network and authority', async () => {
  assert.equal(allowedCampusAddress('10.194.1.2'), true);
  assert.equal(allowedCampusAddress('::ffff:10.194.1.2'), true);
  assert.equal(allowedCampusAddress('127.0.0.1'), false);
  assert.equal(allowedCampusAddress('192.168.1.2'), false);
  assert.equal(allowedCampusAddress('8.8.8.8'), false);
  const denied = createCampusServer({host: '127.0.0.1'});
  const deniedPort = await listen(denied);
  try {assert.equal((await request(deniedPort, '/')).status, 403);} finally {await close(denied);}
  const gateway = createCampusServer({host: '127.0.0.1', allowAddress: () => true});
  const port = await listen(gateway);
  try {
    assert.equal((await request(port, '/_campus/health')).status, 200);
    assert.equal((await request(port, '/_campus/health', {headers: {Host: 'evil.example:4180'}})).status, 403);
    assert.equal((await request(port, '/_campus/health', {headers: {Origin: 'http://evil.example'}})).status, 403);
  } finally {await close(gateway);}
});

test('visitors receive the actual shared state and HTML with local links and controls adapted', async () => {
  const sandbox = createSandboxServer({clock: false});
  const sandboxPort = await listen(sandbox);
  const gateway = createCampusServer({host: '127.0.0.1', sandboxPort, allowAddress: () => true});
  const port = await listen(gateway);
  try {
    const response = await request(port, '/api/simulation', {headers: {
      Origin: 'http://127.0.0.1:4180', 'Accept-Encoding': 'gzip'}});
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], 'gzip');
    const state = JSON.parse(gunzipSync(response.body));
    assert.equal(state.stateVersion, sandbox.runtime.packet().stateVersion);
    assert.equal(state.source, 'synthetic-simulation');
    const html = (await request(port, '/')).body.toString();
    assert.match(html, /href="\/student\/"/);
    assert.doesNotMatch(html, /127\.0\.0\.1:4183/);
    assert.match(html, /<button disabled[^>]+id="reset"/);
    assert.match(html, /<input disabled[^>]+id="northBypassShare"/);
    assert.doesNotMatch(html, /<button disabled[^>]+id="zoomIn"/);
    const before = sandbox.runtime.packet().stateVersion;
    const control = await request(port, '/api/control', {method: 'POST', body: '{"action":"reset"}'});
    assert.equal(control.status, 403);
    assert.equal(sandbox.runtime.packet().stateVersion, before);
    assert.equal((await request(port, '/assets/Map.png')).status, 200);
    for (const path of ['/.env.local', '/server.mjs', '/api/status', '/api/check', '/api/chat', '/api/fixtures/A', '/../AGENT.md'])
      assert.equal((await request(port, path)).status, 404, path);
  } finally {await close(gateway); await close(sandbox);}
});

test('student requests stay same-origin, remain bounded, and obey the per-client question limit', async () => {
  let questions = 0; let observedHost; let observedOrigin;
  const student = http.createServer((req, res) => {
    observedHost = req.headers.host; observedOrigin = req.headers.origin;
    if (req.url === '/student/') {
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end('<a href="http://127.0.0.1:4173/">沙盘</a>'); return;
    }
    questions++;
    req.resume(); req.on('end', () => {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({status: 'ok', source: 'traffic-sandbox-live'}));
    });
  });
  const studentPort = await listen(student);
  const gateway = createCampusServer({host: '127.0.0.1', studentPort, chatLimit: 2, allowAddress: () => true});
  const port = await listen(gateway);
  try {
    assert.match((await request(port, '/student/')).body.toString(), /href="\/"/);
    const options = {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4180'}, body: '{}'};
    assert.equal((await request(port, '/api/student/chat', {...options, headers: {...options.headers, Origin: 'http://evil.example'}})).status, 403);
    assert.equal((await request(port, '/api/student/chat', {method: 'POST'})).status, 415);
    assert.equal((await request(port, '/api/student/chat', options)).status, 200);
    assert.equal(observedHost, '127.0.0.1:' + studentPort);
    assert.equal(observedOrigin, 'http://127.0.0.1:' + studentPort);
    assert.equal((await request(port, '/api/student/chat', options)).status, 200);
    assert.equal((await request(port, '/api/student/chat', options)).status, 429);
    assert.equal(questions, 2);
  } finally {await close(gateway); await close(student);}
});

test('large requests and unavailable backends fail clearly', async () => {
  const unavailable = http.createServer();
  const unavailablePort = await listen(unavailable); await close(unavailable);
  const gateway = createCampusServer({host: '127.0.0.1', sandboxPort: unavailablePort,
    studentPort: unavailablePort, allowAddress: () => true});
  const port = await listen(gateway);
  try {
    assert.equal((await request(port, '/api/simulation')).status, 502);
    assert.equal((await request(port, '/api/student/chat', {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: 'x'.repeat(32769)})).status, 413);
  } finally {await close(gateway);}
});
