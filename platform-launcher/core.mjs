import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile, writeFile, mkdir, rename, open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {X509Certificate} from 'node:crypto';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export function selectCampusAddress(addresses, {requested, preferred, previous} = {}) {
  const available = [...new Set(addresses.filter(value => /^10\.(?:\d{1,3}\.){2}\d{1,3}$/.test(value)))];
  for (const candidate of [requested, preferred, previous]) if (candidate && available.includes(candidate)) return candidate;
  if (available.length === 1) return available[0];
  if (!available.length) throw new Error('没有找到校园网 10.x 地址，请连接校园网后再次启动。');
  throw new Error('存在多个校园网地址，请通过 CAMPUS_HOST 指定要使用的网卡地址。');
}
export function decideService(listeners, port, healthy) {
  const owners = listeners.filter(item => item.port === port);
  if (owners.some(item => !item.owned)) throw new Error('端口 ' + port + ' 被其它程序占用，未关闭或覆盖该程序。');
  if (healthy && owners.length) return 'reuse';
  return owners.length ? 'wait' : 'start';
}
export function assertSharedEntry(expected, actual, {student = false} = {}) {
  const name = student ? '校内师生问答' : '校内沙盘';
  const fail = detail => {throw new Error(name + '未连接到当前沙盘：' + detail + '。请检查部署后再次启动。');};
  if (actual?.source !== (student ? 'traffic-sandbox-live' : 'synthetic-simulation') || actual.runId !== expected.runId)
    fail('仿真轮次不一致');
  if (!student && actual.instanceId !== expected.instanceId) fail('沙盘实例不一致');
  if (![expected.clock?.startSeconds, expected.clock?.seconds, actual.clock?.startSeconds, actual.clock?.seconds].every(Number.isFinite) ||
      !/^\d{2}:\d{2}:\d{2}$/.test(actual.clock?.label || '') || actual.clock.startSeconds !== expected.clock.startSeconds)
    fail('统一时钟不可用或起始时刻不一致');
  // Each endpoint reads a live frame. Allow normal progress between requests.
  if (Math.abs(actual.clock.seconds - expected.clock.seconds) > Math.max(15, (expected.speed || 1) * 10))
    fail('共享时钟明显滞后');
  const scene = expected.departureScenario, received = actual.departureScenario;
  if (!['fixed', 'survey'].includes(scene?.mode) || received?.mode !== scene.mode || !scene.config || !received.config ||
      ['mode', 'classTime', 'totalPeople', 'seed'].some(key => received.config[key] !== scene.config[key]))
    fail('出发场景不一致');
}
export async function requestJson(url, {ca, timeoutMs = 3500} = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = (target.protocol === 'https:' ? https : http).get(target, {
      ...(target.protocol === 'https:' ? {ca, rejectUnauthorized: true, minVersion: 'TLSv1.2'} : {})}, response => {
      if (response.statusCode !== 200) {response.resume(); reject(new Error('HTTP ' + response.statusCode)); return;}
      const chunks = []; let size = 0;
      response.on('data', chunk => {size += chunk.length; if (size > 8 * 1024 * 1024) request.destroy(new Error('响应过大')); else chunks.push(chunk);});
      response.on('error', reject);
      response.on('end', () => {try {resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));} catch {reject(new Error('响应不是有效 JSON'));}});
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}
async function readJson(file) {try {return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));} catch {return null;}}
export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), {recursive: true});
  const temp = file + '.' + process.pid + '.tmp';
  await writeFile(temp, JSON.stringify(value, null, 2)); await rename(temp, file);
}
export function captureProcess(executable, args, {timeoutMs = 30000, env = process.env} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {child.kill(); reject(new Error('启动准备超时'));}, timeoutMs);
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('close', code => {clearTimeout(timer); code === 0 ? resolve(stdout.trim().replace(/^\uFEFF/, '')) : reject(new Error('启动准备失败：' + stderr.trim().slice(-500)));});
  });
}
export function makeNetwork(root = projectRoot) {
  return async (action, host = '', extra = []) => {
    const output = await captureProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(root, 'platform-launcher', 'network.ps1'), '-Action', action, '-ProjectDirectory', root,
      ...(host ? ['-HostAddress', host] : []), ...extra], {timeoutMs: action === 'OpenFirewall' ? 180000 : 20000});
    try {return JSON.parse(output);} catch {throw new Error('无法读取 Windows 网络状态，请检查启动日志。');}
  };
}
export async function spawnService(script, root, env) {
  const logRoot = path.join(root, 'platform-launcher', 'logs'); await mkdir(logRoot, {recursive: true});
  const tag = path.basename(path.dirname(script)) + '-' + Date.now();
  const stdout = await open(path.join(logRoot, tag + '.log'), 'a');
  const stderr = await open(path.join(logRoot, tag + '-error.log'), 'a');
  try {
    const child = spawn(process.execPath, [script], {cwd: path.dirname(script), env,
      windowsHide: true, detached: true, stdio: ['ignore', stdout.fd, stderr.fd]});
    await new Promise((resolve, reject) => {child.once('spawn', resolve); child.once('error', reject);});
    child.unref(); return {pid: child.pid, logTag: tag};
  } finally {await stdout.close(); await stderr.close();}
}

export async function launchPlatform({root = projectRoot, python, log = console.log,
  network = makeNetwork(root), get = requestJson, start = spawnService,
  addresses = Object.values(os.networkInterfaces()).flatMap(items => items.filter(item => item.family === 'IPv4' && !item.internal).map(item => item.address)),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), firewall = true, prepare,
  maxAttempts = 20} = {}) {
  const actions = [], warnings = [];
  let inspection = await network('Inspect');
  const oldGateway = await readJson(path.join(root, 'campus-access', 'runtime.json'));
  const host = selectCampusAddress(addresses, {requested: process.env.CAMPUS_HOST, preferred: inspection.preferredAddress, previous: oldGateway?.host});
  const env = {...process.env, CAMPUS_HOST: host, CAMPUS_PORT: '4180', PORT: '4173', DIFY_LAB_PORT: '4183'};
  log('当前校园网 IP：' + host);
  async function inspect() {inspection = await network('Inspect', host); return inspection;}
  async function probe(url, predicate, options) {try {const data = await get(url, options); return predicate(data) ? data : null;} catch {return null;}}
  async function ready(url, predicate, options) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const data = await probe(url, predicate, options); if (data) return data;
      await sleep(350);
    }
    throw new Error('服务未就绪：' + url + '。请查看 platform-launcher/logs，现有服务没有被强制关闭。');
  }
  async function service({name, port, script, url, predicate, options}) {
    await inspect();
    let data = await probe(url, predicate, options);
    const decision = decideService(inspection.listeners, port, Boolean(data));
    if (decision === 'start') {
      log('启动' + name + '…');
      const created = await start(path.join(root, script), root, env);
      actions.push({service: name, action: 'start', ...created});
      data = await ready(url, predicate, options);
    } else if (decision === 'wait') {
      log(name + '正在启动，等待就绪…'); data = await ready(url, predicate, options);
      actions.push({service: name, action: 'reuse-after-wait'});
    } else {log('复用' + name); actions.push({service: name, action: 'reuse'});}
    await inspect();
    return {data, pid: inspection.listeners.find(item => item.port === port)?.pid};
  }
  const initialPacket = await probe('http://127.0.0.1:4173/api/simulation', packet => Boolean(packet.simulation && packet.source === 'synthetic-simulation'));
  // Preparing keys/certificates is only necessary when absent, expired, or for a new IP.
  // It never creates or changes the user's administrator account or root trust.
  if (prepare) await prepare(host, env);
  else {
    const bridge = path.join(root, 'admin-access', 'private', 'bridge-key.txt');
    let bridgePresent = false; try {bridgePresent = (await readFile(bridge)).length > 0;} catch {}
    if (!bridgePresent) await captureProcess(process.execPath, [path.join(root, 'admin-access', 'server.mjs'), '--prepare'], {env});
    const certificateInfo = await readJson(path.join(root, 'admin-access', 'certificate-info.json'));
    let certificateReady = false;
    try {
      const certificate = new X509Certificate(await readFile(path.join(root, 'admin-access', 'private', 'server-cert.pem')));
      certificateReady = Boolean(certificate.checkIP(host)) && Date.parse(certificate.validTo) > Date.now() + 7 * 86400000;
    } catch {}
    if (!certificateReady || !certificateInfo?.hosts?.includes(host)) {
      if (!python) throw new Error('当前 IP 需要更新管理员 HTTPS 证书，但未找到 Python 运行环境。');
      log('为当前校园网 IP 准备管理员 HTTPS 证书（保留已有根证书）…');
      await captureProcess(python, [path.join(root, 'admin-access', 'prepare-cert.py'), '--directory', path.join(root, 'admin-access'), '--hosts', host]);
      await captureProcess('icacls.exe', [path.join(root, 'admin-access', 'private'), '/inheritance:r', '/grant:r',
        ...(await captureProcess('powershell.exe', ['-NoProfile', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'])).split('\n').map(sid => '*' + sid.trim() + ':(OI)(CI)F'), '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
    }
  }
  const sandbox = await service({name:'沙盘服务',port:4173,script:'traffic-sandbox/server.mjs',url:'http://127.0.0.1:4173/api/simulation',predicate:packet=>Boolean(packet.simulation && packet.source==='synthetic-simulation')});
  if (!initialPacket) warnings.push('沙盘此前未运行，本次由现有服务从初始场景启动；不会声称恢复了未保存的历史车辆。');
  const student = await service({name:'师生问答服务',port:4183,script:'dify-integration-lab/server.mjs',url:'http://127.0.0.1:4183/api/student/state',predicate:packet=>packet.source==='traffic-sandbox-live' && packet.runId===sandbox.data.runId});
  const ca = await readFile(path.join(root, 'admin-access', 'public', 'campus-admin-ca.pem'));
  await inspect();
  const secureHealthy = await probe('https://' + host + ':4190/_admin/health', data=>data.mode==='admin-login', {ca});
  const adminLocalOwners = inspection.listeners.filter(item=>item.port===4174);
  const secureOwners = inspection.listeners.filter(item=>item.port===4190);
  const savedAdmin = await readJson(path.join(root,'admin-access','runtime.json'));
  const currentCertificate = await readJson(path.join(root,'admin-access','certificate-info.json'));
  const certificateReplaced = Boolean(savedAdmin?.leafFingerprint && currentCertificate?.leafFingerprint && savedAdmin.leafFingerprint!==currentCertificate.leafFingerprint);
  if (secureOwners.some(item=>!item.owned)) throw new Error('管理员 HTTPS 4190 端口被其它程序占用，未关闭该程序。');
  if ((!secureHealthy || certificateReplaced) && adminLocalOwners.length) {
    if (adminLocalOwners.some(item=>!item.owned)) throw new Error('管理员 4174 端口被其它程序占用，未关闭该程序。');
    const currentOwner = adminLocalOwners[0];
    // Restart only a stale gateway/admin binding. Sandbox and student services are never stopped.
    if (certificateReplaced || secureOwners.some(item=>item.pid===currentOwner.pid && item.address!==host)) {
      log('管理员入口的 IP 或叶证书已更新，更新管理员入口…');
      await network('StopEntry', host, ['-Entry','admin','-TargetProcessId',String(currentOwner.pid)]);
      actions.push({service:'管理员入口',action:'rebind',previousPid:currentOwner.pid});
    } else if (!secureOwners.length) throw new Error('管理员本机入口已存在，但 HTTPS 入口尚未就绪；请稍后重试，未打断该服务。');
  }
  const admin = await service({name:'管理员登录服务',port:4174,script:'admin-access/server.mjs',url:'http://127.0.0.1:4174/_admin/health',predicate:data=>data.mode==='admin-login'});
  await ready('https://' + host + ':4190/_admin/health',data=>data.mode==='admin-login',{ca});
  await inspect();
  const gatewayHealthy = await probe('http://' + host + ':4180/_campus/health', data=>data.mode==='campus-read-only' && data.host===host);
  const gatewayOwners = inspection.listeners.filter(item=>item.port===4180);
  if (gatewayOwners.some(item=>!item.owned)) throw new Error('校园网 4180 端口被其它程序占用，未关闭该程序。');
  if (!gatewayHealthy && gatewayOwners.length && gatewayOwners.every(item=>item.address!==host)) {
    for (const owner of gatewayOwners) await network('StopEntry',host,['-Entry','gateway','-TargetProcessId',String(owner.pid)]);
    actions.push({service:'校园网入口',action:'rebind'});
    log('校园网入口仍绑定旧 IP，更新校园网入口…');
  }
  const gateway = await service({name:'校园网师生入口',port:4180,script:'campus-access/server.mjs',url:'http://'+host+':4180/_campus/health',predicate:data=>data.mode==='campus-read-only' && data.host===host});
  if (!gateway.pid) throw new Error('校园网入口在启动检查期间退出，请待其它部署完成后重试。');
  await atomicJson(path.join(root,'campus-access','runtime.json'),{host,port:4180,pid:gateway.pid});
  await inspect();
  let firewallReady = inspection.firewallReady;
  if (firewall && !firewallReady) {
    log('需要 Windows 管理员授权，只放行校园网 10.x 到本机 4180/4190；请在系统提示中确认。');
    const result = await network('OpenFirewall',host);
    firewallReady = result.ready;
    if (!firewallReady) warnings.push(result.message || '校园网防火墙尚未放行，请再次运行一键启动并完成 Windows 管理员授权。');
  }
  const finalPacket = await ready('http://127.0.0.1:4173/api/simulation',packet=>Boolean(packet.simulation));
  if (initialPacket && (initialPacket.runId!==finalPacket.runId || initialPacket.instanceId!==finalPacket.instanceId))
    throw new Error('启动期间检测到沙盘由其它操作重新启动或重置；请等待另一聊天完成部署后再启动。本启动器未停止沙盘。');
  log('核验校内沙盘、师生端与最新出发场景的共享连接…');
  const [viewerState, studentState] = await Promise.all([
    get('http://' + host + ':4180/api/simulation'),
    get('http://' + host + ':4180/api/student/state')
  ]);
  assertSharedEntry(finalPacket, viewerState);
  assertSharedEntry(finalPacket, studentState, {student: true});
  const scene = {mode: finalPacket.departureScenario.mode,
    label: finalPacket.departureScenario.mode === 'survey' ? '问卷分批出发' : '固定需求',
    clock: finalPacket.clock.label, classTime: finalPacket.clock.classTime,
    ...(finalPacket.departureScenario.mode === 'survey' ? {totalPeople: finalPacket.departureScenario.config.totalPeople} : {})};
  const urls = {localAdmin:'http://127.0.0.1:4174/login',viewer:'http://'+host+':4180/',student:'http://'+host+':4180/student/',admin:'https://'+host+':4190/login'};
  const report = {checkedAt:new Date().toISOString(),host,urls,firewallReady,actions,warnings,
    preservedExistingSandbox:Boolean(initialPacket),runId:finalPacket.runId,instanceId:finalPacket.instanceId,
    sharedStateVerified: true, scene,
    processes:{sandbox:sandbox.pid,student:student.pid,admin:admin.pid,gateway:gateway.pid}};
  await atomicJson(path.join(root,'platform-launcher','last-start.json'),report);
  const lines = ['校园交通平台已启动。', '当前场景：' + scene.label + ' · 沙盘时刻 ' + scene.clock + (scene.classTime ? ' · 上课 ' + scene.classTime : ''),
    '校内沙盘与师生端：已核验共享同一仿真。', '', '本机管理员：'+urls.localAdmin,
    '校内查看沙盘：'+urls.viewer,'校内师生问答：'+urls.student,'校内管理员：'+urls.admin,
    '', '校园网防火墙：'+(firewallReady?'已核验放行':'尚未确认放行'),
    '其它管理设备首次访问 HTTPS 需按 admin-access/README.md 安装项目专用证书。',
    '电脑需保持开机、不休眠；重新连接校园网后请再次双击启动，查看最新地址。',
    '关闭这个启动窗口不会关闭已经运行的服务。', ...warnings.map(message=>'提示：'+message)];
  await writeFile(path.join(root,'平台访问地址.txt'),'\uFEFF'+lines.join('\r\n')+'\r\n','utf8');
  log('\n'+lines.join('\n'));
  return report;
}
