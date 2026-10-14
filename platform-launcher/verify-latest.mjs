import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {projectRoot, requestJson, atomicJson, makeNetwork, assertSharedEntry} from './core.mjs';

const evidenceRoot = path.join(projectRoot, 'platform-launcher', 'evidence');
const beforeFile = path.join(evidenceRoot, 'latest-sandbox-before.json');
const lastStart = JSON.parse(await readFile(path.join(projectRoot, 'platform-launcher', 'last-start.json'), 'utf8'));
const local = await requestJson('http://127.0.0.1:4173/api/simulation');
const inspection = await makeNetwork()('Inspect', lastStart.host);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const deployedFiles = JSON.parse(await readFile(path.join(projectRoot, 'traffic-sandbox', 'evidence', 'survey-departures', 'final-files-check.json'), 'utf8'));
const codeHashes = Object.fromEntries(await Promise.all(deployedFiles.map(async ({file}) => [file, sha(await readFile(path.join(projectRoot, file)))])));
const processes = Object.fromEntries(Object.entries({sandbox:4173, student:4183, admin:4174, gateway:4180}).map(([name, port]) => {
  const listener = inspection.listeners.find(item => item.port === port);
  assert.equal(listener?.owned, true, name + ' process identity');
  return [name, listener.pid];
}));
const summary = {checkedAt:new Date().toISOString(), host:lastStart.host, processes,
  runId:local.runId, instanceId:local.instanceId, simulationTimeSeconds:local.simulation.time,
  settings:local.simulation.settings, running:local.running, speed:local.speed,
  clock:local.clock, departureScenario:local.departureScenario, codeHashes};
if (process.argv.includes('--before')) {
  await atomicJson(beforeFile, summary);
  console.log(JSON.stringify({savedBeforeStartup:true, ...summary}, null, 2));
} else {
  const before = JSON.parse(await readFile(beforeFile, 'utf8'));
  assert.deepEqual(processes, before.processes, 'one-click startup must preserve all running processes');
  assert.equal(local.runId, before.runId);
  assert.equal(local.instanceId, before.instanceId);
  assert.deepEqual(local.simulation.settings, before.settings);
  assert.equal(local.running, before.running);
  assert.equal(local.speed, before.speed);
  assert.deepEqual(local.departureScenario.config, before.departureScenario.config);
  assert.ok(local.simulation.time >= before.simulationTimeSeconds);
  assert.equal(lastStart.sharedStateVerified, true);
  assert.equal(lastStart.preservedExistingSandbox, true);
  assert.ok(lastStart.actions.every(item => item.action === 'reuse'));
  assert.equal(inspection.firewallReady, true);
  const origin = 'http://' + lastStart.host + ':4180';
  const [viewer, student] = await Promise.all([
    requestJson(origin + '/api/simulation'), requestJson(origin + '/api/student/state')
  ]);
  assertSharedEntry(local, viewer);
  assertSharedEntry(local, student, {student:true});
  assert.deepEqual(student.settings, local.simulation.settings);
  const resources = [
    ['/app.mjs','traffic-sandbox/dist/app.mjs'], ['/engine.mjs','traffic-sandbox/dist/engine.mjs'],
    ['/route.mjs','traffic-sandbox/dist/route.mjs'], ['/shared-client.mjs','traffic-sandbox/dist/shared-client.mjs'],
    ['/style.css','traffic-sandbox/dist/style.css'], ['/student/app.mjs','dify-integration-lab/public/student/app.mjs'],
    ['/student/style.css','dify-integration-lab/public/student/style.css']
  ];
  const resourceChecks = await Promise.all(resources.map(async ([url, file]) => {
    const response = await fetch(origin + url, {signal:AbortSignal.timeout(5000)});
    assert.equal(response.status, 200, url);
    const served = Buffer.from(await response.arrayBuffer()), disk = await readFile(path.join(projectRoot, file));
    assert.equal(sha(served), sha(disk), url + ' must serve the latest file');
    return {url, matchesCurrentFile:true, sha256:sha(served)};
  }));
  const html = await (await fetch(origin + '/', {signal:AbortSignal.timeout(5000)})).text();
  for (const id of ['departureMode','classTime','totalPeople','applyDepartureScenario'])
    assert.match(html, new RegExp('<(?:select|input|button)\\b(?=[^>]*\\bid="' + id + '")(?=[^>]*\\bdisabled)[^>]*>'));
  assert.match(html, /href="\/student\/"/);
  assert.match(html, /管理员登录/);
  const denied = await fetch(origin + '/api/control', {method:'POST', headers:{'Content-Type':'application/json', Origin:origin},
    body:JSON.stringify({action:'departureScenario', config:{mode:'survey'}}), signal:AbortSignal.timeout(5000)});
  assert.equal(denied.status, 403);
  const ca = await readFile(path.join(projectRoot, 'admin-access', 'public', 'campus-admin-ca.pem'));
  assert.equal((await requestJson('https://' + lastStart.host + ':4190/_admin/health', {ca})).mode, 'admin-login');
  assert.deepEqual(codeHashes, before.codeHashes, 'integration must preserve the latest sandbox and student source files');
  const evidence = {...summary, beforeTimeSeconds:before.simulationTimeSeconds, preservedProcessesAndScene:true,
    sameSharedClockAndScene:true, anonymousScenarioControlDenied:true, adminHttpsVerifiedWithCaAndIp:true,
    firewallReady:true, resourceChecks, latestSourceFilesPreserved:deployedFiles.length, otherDeviceRetest:false,
    newSceneActivation:'not-activated-in-live-platform', automaticCheckpointRestore:'not-implemented'};
  await atomicJson(path.join(evidenceRoot, 'latest-sandbox-integration.json'), evidence);
  console.log(JSON.stringify(evidence, null, 2));
}
