import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {launchPlatform, selectCampusAddress, decideService, requestJson, isAutomaticReplay} from '../core.mjs';

test('IP changes prefer the current route and ignore stale saved addresses', () => {
  assert.equal(selectCampusAddress(['10.194.56.155'],{requested:'10.196.106.35',previous:'10.196.106.35'}),'10.194.56.155');
  assert.equal(selectCampusAddress(['10.194.1.2','10.196.2.3'],{preferred:'10.196.2.3'}),'10.196.2.3');
  assert.throws(()=>selectCampusAddress(['192.168.1.2']),/校园网/);
  assert.throws(()=>selectCampusAddress(['10.1.1.2','10.2.2.3']),/多个/);
});

test('foreign ports are never reused or stopped, even if they imitate a health response', () => {
  assert.throws(()=>decideService([{port:4173,owned:false}],4173,true),/其它程序/);
  assert.equal(decideService([{port:4173,owned:true}],4173,false),'wait');
  assert.equal(decideService([],4173,false),'start');
});

async function fixture(t,{running=true,staleEntries=false,foreign=false,firewallReady=true,cancel=false}={}) {
  const prefix=path.join(os.tmpdir(),'zju-platform-launcher-test-');
  const root=await mkdtemp(prefix);
  t.after(async()=>{if(!path.resolve(root).startsWith(path.resolve(prefix)))throw new Error('Unexpected test directory');await rm(root,{recursive:true,force:true});});
  await mkdir(path.join(root,'admin-access','public'),{recursive:true});
  await writeFile(path.join(root,'admin-access','public','campus-admin-ca.pem'),'test CA placeholder');
  const host='10.194.56.155',oldHost='10.196.106.35';
  const state={listeners:[],calls:[],firewallReady,packet:{source:'synthetic-simulation',runId:'same-run',instanceId:'same-instance',speed:4,
    clock:{startSeconds:28200,seconds:28700,label:'07:58:20',classTime:null},
    departureScenario:{mode:'fixed',config:{mode:'fixed',classTime:'08:00',totalPeople:360,seed:20261014}},
    simulation:{time:500,settings:{northBypassShare:60}}}};
  const add=(port,pid,address='127.0.0.1')=>state.listeners.push({port,pid,address,owned:true});
  if(running){add(4173,11);add(4183,12);add(4174,13);add(4190,13,staleEntries?oldHost:host);add(4180,14,staleEntries?oldHost:host);}
  if(foreign)state.listeners=[{port:4173,pid:99,address:'127.0.0.1',owned:false}];
  const network=async(action,address,extra=[])=>{
    state.calls.push({action,address,extra});
    if(action==='Inspect')return {listeners:structuredClone(state.listeners),preferredAddress:host,firewallReady:state.firewallReady};
    if(action==='OpenFirewall'){state.firewallReady=!cancel;return {ready:!cancel,message:cancel?'Windows 授权未完成':undefined};}
    if(action==='StopEntry'){
      const pid=Number(extra[extra.indexOf('-TargetProcessId')+1]);state.listeners=state.listeners.filter(item=>item.pid!==pid);return {stopped:pid};
    }
    throw new Error('Unexpected action');
  };
  const get=async url=>{
    const u=new URL(url),port=Number(u.port);
    if(!state.listeners.some(item=>item.port===port&&item.address===u.hostname))throw new Error('not listening');
    if(port===4173)return structuredClone(state.packet);
    const studentState=()=>({source:'traffic-sandbox-live',runId:state.packet.runId,
      clock:structuredClone(state.packet.clock),departureScenario:structuredClone(state.packet.departureScenario)});
    if(port===4183)return studentState();
    if(port===4174||port===4190)return {mode:'admin-login'};
    if(port===4180){
      if(u.pathname==='/api/simulation')return structuredClone(state.packet);
      if(u.pathname==='/api/student/state')return studentState();
      return {mode:'campus-read-only',host:u.hostname};
    }
    throw new Error('Unexpected URL');
  };
  const start=async script=>{
    const name=path.basename(path.dirname(script));state.calls.push({action:'start',name});
    if(name==='traffic-sandbox')add(4173,11);
    else if(name==='dify-integration-lab')add(4183,12);
    else if(name==='admin-access'){add(4174,23);add(4190,23,host);}
    else if(name==='campus-access')add(4180,24,host);
    return {pid:state.listeners.at(-1).pid};
  };
  return {state,options:{root,addresses:[host],network,get,start,prepare:async()=>{},sleep:async()=>{},maxAttempts:2,log:()=>{}}};
}

test('repeated startup reuses all services and preserves the running simulation',async t=>{
  const {state,options}=await fixture(t);
  const first=await launchPlatform(options),second=await launchPlatform(options);
  assert.equal(first.runId,'same-run');assert.equal(second.instanceId,'same-instance');
  assert.equal(second.sharedStateVerified,true);assert.equal(second.scene.mode,'fixed');
  assert.equal(state.calls.filter(item=>item.action==='start'||item.action==='StopEntry').length,0);
  assert.deepEqual(second.processes,{sandbox:11,student:12,admin:13,gateway:14});
  const addressFile=await readFile(path.join(options.root,'平台访问地址.txt'),'utf8');
  assert.match(addressFile,/10\.194\.56\.155:4180\/student\//);
  assert.equal(JSON.parse(await readFile(path.join(options.root,'platform-launcher','last-start.json'),'utf8')).firewallReady,true);
});

test('automatic replay is distinct from a manual reset or a service restart',()=>{
 const before={instanceId:'same',runId:'old',autoReplay:{enabled:true,cycles:0,startTime:'07:00',endTime:'08:00'}};
 const after={...before,runId:'new',autoReplay:{...before.autoReplay,cycles:1}};
 assert.equal(isAutomaticReplay(before,after),true);
 for(const packet of [{...after,instanceId:'restarted'},{...after,autoReplay:{...after.autoReplay,cycles:0}},{...after,autoReplay:{...after.autoReplay,enabled:false}},{...after,autoReplay:undefined}])assert.equal(isAutomaticReplay(before,packet),false);
});

test('crossing 08:00 during startup rereads consistent shared entries without restarting services',async t=>{
 const {state,options}=await fixture(t),get=options.get;
 state.packet.departureScenario={mode:'survey',config:{mode:'survey',classTime:'08:00',totalPeople:360,seed:20261014}};
 state.packet.clock={startSeconds:25200,seconds:28799,label:'07:59:59',classTime:'08:00'};
 state.packet.autoReplay={configured:true,enabled:true,cycles:0,startTime:'07:00',endTime:'08:00'};
 let crossed=false;
 options.get=async(url,extra)=>{
  const target=new URL(url);
  if(!crossed&&target.port==='4180'&&target.pathname==='/api/simulation'){
   crossed=true;state.packet.runId='next-loop';state.packet.autoReplay.cycles++;
   state.packet.clock={...state.packet.clock,seconds:25200,label:'07:00:00'};
  }
  return get(url,extra);
 };
 const result=await launchPlatform(options);assert.equal(result.runId,'next-loop');assert.equal(result.sharedStateVerified,true);
 assert.equal(state.calls.filter(item=>item.action==='start'||item.action==='StopEntry').length,0);
});

test('one stale student cache frame after automatic replay is retried before reporting a mismatch',async t=>{
 const {state,options}=await fixture(t),get=options.get;let expired=false,waits=0;
 state.packet.autoReplay={configured:true,enabled:true,cycles:1,startTime:'07:00',endTime:'08:00'};
 options.sleep=async ms=>{assert.equal(ms,550);waits++;expired=true;};
 options.get=async(url,extra)=>{
  const packet=await get(url,extra),target=new URL(url);
  if(!expired&&target.port==='4180'&&target.pathname==='/api/student/state')packet.runId='previous-loop';
  return packet;
 };
 const result=await launchPlatform(options);assert.equal(result.sharedStateVerified,true);assert.equal(waits,1);
 assert.equal(state.calls.filter(item=>item.action==='start'||item.action==='StopEntry').length,0);
});

test('cold startup starts missing dependencies in order and reports initial-scene recovery limits',async t=>{
  const {state,options}=await fixture(t,{running:false});
  const report=await launchPlatform(options);
  assert.deepEqual(state.calls.filter(item=>item.action==='start').map(item=>item.name),['traffic-sandbox','dify-integration-lab','admin-access','campus-access']);
  assert.equal(report.preservedExistingSandbox,false);assert.match(report.warnings[0],/初始场景/);
  assert.deepEqual(JSON.parse(await readFile(path.join(options.root,'campus-access','runtime.json'),'utf8')),{host:'10.194.56.155',port:4180,pid:24});
});

test('changed IP rebinds only gateway/admin entries and leaves sandbox/student processes intact',async t=>{
  const {state,options}=await fixture(t,{staleEntries:true,firewallReady:false});
  const report=await launchPlatform(options);
  const stopped=state.calls.filter(item=>item.action==='StopEntry').map(item=>Number(item.extra[item.extra.indexOf('-TargetProcessId')+1]));
  assert.deepEqual(stopped,[13,14]);assert.equal(report.processes.sandbox,11);assert.equal(report.processes.student,12);
  assert.equal(report.firewallReady,true);assert.equal(report.preservedExistingSandbox,true);
});

test('foreign port failure does not terminate any process or start a duplicate sandbox',async t=>{
  const {state,options}=await fixture(t,{foreign:true});
  await assert.rejects(launchPlatform(options),/其它程序/);
  assert.equal(state.calls.filter(item=>item.action==='StopEntry'||item.action==='start').length,0);
});

test('renewed leaf certificate restarts only the administrator entry',async t=>{
  const {state,options}=await fixture(t);
  await writeFile(path.join(options.root,'admin-access','runtime.json'),JSON.stringify({leafFingerprint:'old'}));
  await writeFile(path.join(options.root,'admin-access','certificate-info.json'),JSON.stringify({leafFingerprint:'new'}));
  const report=await launchPlatform(options);
  const stops=state.calls.filter(item=>item.action==='StopEntry');
  assert.equal(stops.length,1);assert.equal(stops[0].extra[1],'admin');
  assert.equal(report.processes.sandbox,11);assert.equal(report.processes.student,12);assert.equal(report.processes.gateway,14);
});

test('canceled Windows authorization leaves services available and records a clear warning',async t=>{
  const {options}=await fixture(t,{firewallReady:false,cancel:true});
  const report=await launchPlatform(options);
  assert.equal(report.firewallReady,false);assert.match(report.warnings.join(' '),/授权未完成/);
});

test('a running questionnaire scene remains selected and is checked through both campus entries',async t=>{
  const {state,options}=await fixture(t);
  state.packet.departureScenario={mode:'survey',config:{mode:'survey',classTime:'09:00',totalPeople:720,seed:20261014}};
  state.packet.clock={startSeconds:28800,seconds:29300,label:'08:08:20',classTime:'09:00'};
  const report=await launchPlatform(options);
  assert.equal(report.scene.mode,'survey');assert.equal(report.scene.totalPeople,720);assert.equal(report.scene.classTime,'09:00');
  assert.equal(state.calls.filter(item=>item.action==='start'||item.action==='StopEntry').length,0);
  assert.match(await readFile(path.join(options.root,'平台访问地址.txt'),'utf8'),/问卷分批出发.*09:00/);
});

test('a healthy gateway with stale student scene or clock cannot report successful startup',async t=>{
  for (const defect of ['scene','clock','runId']) {
    const {state,options}=await fixture(t);
    const originalGet=options.get;
    options.get=async url=>{
      const value=await originalGet(url);
      if(url.includes(':4180/api/student/state')){
        if(defect==='scene')value.departureScenario.config.totalPeople=999;
        if(defect==='clock')value.clock.seconds-=120;
        if(defect==='runId')value.runId='old-run';
      }
      return value;
    };
    await assert.rejects(launchPlatform(options),/校内师生问答未连接到当前沙盘/);
    assert.equal(state.calls.filter(item=>item.action==='start'||item.action==='StopEntry').length,0);
    await assert.rejects(readFile(path.join(options.root,'platform-launcher','last-start.json')),/ENOENT/);
  }
});

test('unavailable campus data route is detected even when its health endpoint works',async t=>{
  const {state,options}=await fixture(t);const originalGet=options.get;
  options.get=async url=>{if(url.includes(':4180/api/simulation'))throw new Error('HTTP 502');return originalGet(url);};
  await assert.rejects(launchPlatform(options),/HTTP 502/);
  assert.equal(state.calls.filter(item=>item.action==='start'||item.action==='StopEntry').length,0);
});

test('real HTTP health reader rejects non-JSON, errors and timeouts',async t=>{
  const server=http.createServer((req,res)=>{
    if(req.url==='/json'){res.end('{"mode":"ready"}');return;}
    if(req.url==='/error'){res.writeHead(503);res.end('down');return;}
    if(req.url==='/hang')return;
    res.end('<html>not a health endpoint</html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base='http://127.0.0.1:'+server.address().port;
  assert.equal((await requestJson(base+'/json')).mode,'ready');
  await assert.rejects(requestJson(base+'/error'),/HTTP 503/);
  await assert.rejects(requestJson(base+'/html'),/JSON/);
  await assert.rejects(requestJson(base+'/hang',{timeoutMs:100}),/timeout/);
});
