import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {campusAddresses} from './server.mjs';

const host = process.env.CAMPUS_HOST || campusAddresses()[0]?.address;
if (!host) throw new Error('未找到校园网地址');
const base = 'http://' + host + ':' + (process.env.CAMPUS_PORT || 4180);
const results = [];
async function check(path, expected = 200, options = {}) {
  const response = await fetch(base + path, {signal: AbortSignal.timeout(70000), ...options});
  const text = await response.text();
  if (response.status !== expected) throw new Error(path + ': HTTP ' + response.status + ' ' + text.slice(0, 160));
  results.push({path, status: response.status});
  return text;
}
const html = await check('/');
if (html.includes('href="http://127.0.0.1:4183')) throw new Error('沙盘仍有本机跳转');
if (!/<button disabled[^>]+id="reset"/.test(html)) throw new Error('策略控件未禁用');
const student = await check('/student/');
if (student.includes('href="http://127.0.0.1:4173')) throw new Error('师生端仍有本机跳转');
for (const path of ['/assets/Map.png', '/assets/zju-emblem.png', '/student/app.mjs', '/student/style.css', '/student/emblem.png'])
  await check(path);
const packet = JSON.parse(await check('/api/simulation'));
const state = JSON.parse(await check('/api/student/state'));
if (packet.runId !== state.runId || state.source !== 'traffic-sandbox-live') throw new Error('两端未共享同一仿真');
await check('/api/control', 403, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{"action":"reset"}'});
await check('/api/simulation', 403, {headers: {Origin: 'http://other.example'}});
await check('/.env.local', 404);
await check('/api/chat', 404, {method: 'POST'});
console.log('页面、资源、两端共享状态、只读和跨站限制检查通过。');
const reply = JSON.parse(await check('/api/student/chat', 200, {method: 'POST', headers: {
  'Content-Type': 'application/json', Origin: base}, body: JSON.stringify({
    question: '根据当前沙盘，哪条路线更省时？', trip: {origin: '1', destination: '2', mode: 'electric'},
    preference: 'time', sessionId: 'campus-validation-' + randomUUID()})}));
if (reply.provider !== 'school-dify' || reply.status !== 'ok' || reply.runId !== packet.runId)
  throw new Error('学校 Dify 未返回可核验的同源路线建议');
const record = {checkedAt: new Date().toISOString(), base, tests: results, sameRunId: packet.runId,
  stateVersion: reply.stateVersion, provider: reply.provider, recommendedRouteId: reply.recommendedRouteId,
  routes: reply.routes.map(route => ({id: route.id, name: route.name})),
  limitation: '本机通过校园网IP访问已验证；第二台设备及跨网段访问仍待实测。'};
await writeFile(new URL('./live-validation.json', import.meta.url), JSON.stringify(record, null, 2));
console.log(JSON.stringify({base, checks: results.length, provider: reply.provider,
  stateVersion: reply.stateVersion, recommendedRouteId: reply.recommendedRouteId, crossDevice: 'pending'}, null, 2));
