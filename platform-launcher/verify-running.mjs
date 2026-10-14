import {readFile, writeFile} from 'node:fs/promises';
import {requestJson} from './core.mjs';

const first=JSON.parse(await readFile(new URL('./evidence/first-success.json',import.meta.url),'utf8'));
const second=JSON.parse(await readFile(new URL('./last-start.json',import.meta.url),'utf8'));
if(first.runId!==second.runId||first.instanceId!==second.instanceId)throw new Error('重复启动改变了沙盘实例');
if(JSON.stringify(first.processes)!==JSON.stringify(second.processes))throw new Error('重复启动改变了服务进程');
if(second.actions.some(action=>action.action!=='reuse'))throw new Error('本次启动未完全复用现有服务');
const packet=await requestJson('http://127.0.0.1:4173/api/simulation');
const viewerPacket=await requestJson('http://'+second.host+':4180/api/simulation');
const student=await requestJson('http://'+second.host+':4180/api/student/state');
const ca=await readFile(new URL('../admin-access/public/campus-admin-ca.pem',import.meta.url));
const admin=await requestJson('https://'+second.host+':4190/_admin/health',{ca});
if(packet.runId!==second.runId||viewerPacket.runId!==packet.runId||student.runId!==packet.runId||admin.mode!=='admin-login')throw new Error('入口与共享服务状态不一致');
if(!second.firewallReady)throw new Error('校园网防火墙未确认');
const evidence={checkedAt:new Date().toISOString(),host:second.host,urls:second.urls,
  sameProcesses:true,processes:second.processes,sameRunId:true,runId:packet.runId,sameInstanceId:true,
  firewallReady:true,campusViewerSharedState:true,campusStudentSharedState:true,adminHttpsVerifiedWithProjectCa:true,
  actualRestartTest:'未停止正在修改的沙盘；冷启动与IP更换采用隔离依赖测试',
  actualOtherDeviceRetest:'not-performed-this-turn'};
await writeFile(new URL('./evidence/repeated-start-validation.json',import.meta.url),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
