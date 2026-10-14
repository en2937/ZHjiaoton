import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {projectRoot, requestJson, atomicJson} from './core.mjs';

const report = JSON.parse(await readFile(path.join(projectRoot, 'platform-launcher', 'last-start.json'), 'utf8'));
const origin = 'http://' + report.host + ':4180';
const question = '现在从宿舍到教学区骑电动车，哪条路线用时更短？';
const state = await requestJson(origin + '/api/student/state');
const started = Date.now();
const response = await fetch(origin + '/api/student/chat', {method:'POST',
  headers:{'Content-Type':'application/json', Origin:origin},
  body:JSON.stringify({question, trip:{origin:'1', destination:'2', mode:'electric'}, preference:'time', sessionId:randomUUID()}),
  signal:AbortSignal.timeout(70000)});
const reply = await response.json();
assert.equal(response.status, 200, 'student chat HTTP status');
assert.equal(reply.provider, 'school-dify', 'must use the configured school AI');
assert.equal(reply.status, 'ok', 'route answer must be available');
assert.equal(reply.runId, state.runId, 'AI must use the current simulation');
assert.equal(reply.clock.startSeconds, state.clock.startSeconds);
assert.deepEqual(reply.settings, state.settings);
assert.equal(reply.routes.length, 3);
assert.ok(reply.routes.some(route => route.id === reply.recommendedRouteId));
const evidence = {checkedAt:new Date().toISOString(), url:origin + '/api/student/chat', question,
  status:reply.status, provider:reply.provider, runId:reply.runId, stateVersion:reply.stateVersion,
  clock:reply.clock, settings:reply.settings, recommendedRouteId:reply.recommendedRouteId,
  routes:reply.routes, message:reply.message, elapsedMs:Date.now() - started,
  usedCurrentSimulation:true, performedThroughCampusGateway:true, realBrowserTest:false, otherDeviceTest:false};
await atomicJson(path.join(projectRoot, 'platform-launcher', 'evidence', 'latest-real-ai-check.json'), evidence);
console.log(JSON.stringify(evidence, null, 2));
