import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {Simulation,createOvertakingDemo,departureConfig,observationOffset} from './dist/engine.mjs';
import {sameSettings,validSettings} from './control-settings.mjs';
const routingMode=config=>config?.mode==='survey'?'grouped':'original';
const scenarioSettings=(settings,config)=>({...settings,behaviorMode:routingMode(config)});
const HOUR_SECONDS=3600,LOOP_EPSILON=1e-7;
// One local service owns the simulation. Browser tabs are views of this state.
export class SharedSimulation {
 constructor({running=true,speed=4,seed=20261012,settings={},departureScenario={},initialPacket,preserveRunId=false,loopDefaultWindow=initialPacket?.autoReplay?.configured??false}={}) {
  const config=departureConfig(departureScenario);
  this.sim=new Simulation({seed,settings:scenarioSettings(settings,config),departureScenario:config});this.initialSeed=initialPacket?.initialSeed??seed;
  this.instanceId=randomUUID();this.runId=randomUUID();this.revision=0;this.settingsRevision=Number.isSafeInteger(initialPacket?.settingsRevision)?initialPacket.settingsRevision:0;
  this.running=running;this.speed=speed;this.updatedAt=new Date().toISOString();
  this.loopDefaultWindow=loopDefaultWindow;
  this.loopCount=Number.isSafeInteger(initialPacket?.autoReplay?.cycles)&&initialPacket.autoReplay.cycles>=0?initialPacket.autoReplay.cycles:0;
  if(initialPacket?.simulation){
   this.sim=Object.assign(Object.create(Simulation.prototype),structuredClone(initialPacket.simulation));
   // Only upgrade legacy snapshots. Reinitializing current snapshots changes routing history.
   if(!Object.hasOwn(this.sim.settings,'northBypassShare')||Object.hasOwn(this.sim.settings,'branchShare')||!this.sim.bypassStats)this.sim.initializeBypassRouting(initialPacket.simulation.settings.northBypassShare??60);
   this.sim.initializeBehavior();
   const expectedMode=routingMode(this.sim.departureScenario);
   if(this.sim.settings.behaviorMode!==expectedMode){this.sim.setSettings({behaviorMode:expectedMode});this.settingsRevision++;}
   this.running=initialPacket.running;this.speed=initialPacket.speed;if(preserveRunId&&typeof initialPacket.runId==='string')this.runId=initialPacket.runId;this.changed();
  }
  // A saved default demonstration may already be past 08:00. Do not replay its
  // old backlog or silently replace an administrator's different scenario.
  if(this.defaultWindowActive()&&this.sim.time>=HOUR_SECONDS-LOOP_EPSILON)this.restartDefaultWindow();
 }
 changed(){this.revision++;this.updatedAt=new Date().toISOString();}
 defaultWindowActive(){
  const config=this.sim.departureScenario;
  return this.loopDefaultWindow&&!this.sim.demo&&config?.mode==='survey'&&config.classTime==='08:00'&&observationOffset(config)===0;
 }
 restartDefaultWindow(){
  this.sim=this.makeScenario({...this.sim.settings},this.sim.departureScenario);
  this.runId=randomUUID();this.settingsRevision++;this.loopCount++;this.changed();
 }
 advance(seconds){
  if(!this.running||!(seconds>0))return;
  const dt=Math.min(seconds,.25)*this.speed;
  if(this.defaultWindowActive()&&this.sim.time+dt>=HOUR_SECONDS-LOOP_EPSILON){
   const remaining=Math.max(0,HOUR_SECONDS-this.sim.time);
   if(remaining>LOOP_EPSILON)this.sim.step(Math.min(remaining,dt));
   this.restartDefaultWindow();
   const overflow=Math.max(0,dt-remaining);if(overflow>LOOP_EPSILON)this.sim.step(overflow);
  }else this.sim.step(dt);
  this.changed();
 }
 makeScenario(settings,config){const sim=new Simulation({seed:this.initialSeed,settings:scenarioSettings(settings,config),departureScenario:config});if(sim.departureScenario.mode==='survey')sim.step(observationOffset(sim.departureScenario));return sim;}
 async controlAsync(command={}){
  if(command.expected)return this.control(command);
  if(command.action!=='departureScenario'&&!(command.action==='reset'&&this.sim.departureScenario?.mode==='survey'))return this.control(command);
  if(command.action==='departureScenario'&&(!command.config||!Object.hasOwn(command.config,'mode')))throw new Error('请明确选择出发模式。');
  const config=departureConfig(command.action==='reset'?this.sim.departureScenario:command.config),offset=observationOffset(config);
  if(command.expectedRunId&&command.expectedRunId!==this.runId){const error=new Error('场景已改变，请刷新后再启用。');error.status=409;throw error;}
  if(config.mode!=='survey'||offset===0)return this.control(command);
  if(this.preparingObservation){const error=new Error('正在准备观察场景，请稍后重试。');error.status=409;throw error;}
  const baseline={runId:this.runId,settingsRevision:this.settingsRevision,settings:{...this.sim.settings}};
  this.preparingObservation=true;
  try{
   const worker=new Worker(new URL('./observation-worker.mjs',import.meta.url),{workerData:{seed:this.initialSeed,settings:scenarioSettings(baseline.settings,config),config,offset}});
   const prepared=await new Promise((resolve,reject)=>{let received=false;worker.once('message',value=>{received=true;resolve(value);});worker.once('error',reject);worker.once('exit',()=>{if(!received)reject(new Error('观察场景准备失败，请重试。'));});});
   if(this.runId!==baseline.runId||this.settingsRevision!==baseline.settingsRevision||!sameSettings(this.sim.settings,baseline.settings)){const error=new Error('准备期间参数或场景已改变，请重新启用。');error.status=409;throw error;}
   this.sim=Object.assign(Object.create(Simulation.prototype),prepared);this.runId=randomUUID();this.settingsRevision++;this.changed();return this.packet();
  }finally{this.preparingObservation=false;}
 }
 packet(){return {schemaVersion:1,source:'synthetic-simulation',instanceId:this.instanceId,runId:this.runId,
  behavior:{...this.sim.behaviorState(),modeSource:'departureScenario',runId:this.runId,settingsRevision:this.settingsRevision,stateVersion:this.runId+':'+this.revision,updatedAt:this.updatedAt},initialSeed:this.initialSeed,clock:this.sim.clockState(),departureScenario:this.sim.departureState(),stateVersion:this.runId+':'+this.revision,revision:this.revision,settingsRevision:this.settingsRevision,updatedAt:this.updatedAt,
  running:this.running,speed:this.speed,...(this.loopDefaultWindow?{autoReplay:{configured:true,enabled:this.defaultWindowActive(),startTime:'07:00',endTime:'08:00',cycles:this.loopCount}}:{}),simulation:this.sim};}
 control(command={}) {
  if(!['settings','play','speed','reset','preset','demo','departureScenario'].includes(command.action))throw new Error('未知沙盘操作');
  if(command.expected){
   if(command.action!=='settings'||!validSettings(command.settings)||!sameSettings(command.expected.settings,this.sim.settings)||command.expected.runId!==this.runId||command.expected.settingsRevision!==this.settingsRevision){const error=new Error('参数或场景已改变，请基于当前状态重新调整。');error.status=409;throw error;}
  }
  if(command.action==='departureScenario'){
   if(!command.config||!Object.hasOwn(command.config,'mode'))throw new Error('请明确选择出发模式。');
   const config=departureConfig(command.config);
   if(command.expectedRunId&&command.expectedRunId!==this.runId){const error=new Error('场景已改变，请刷新后再启用。');error.status=409;throw error;}
   this.sim=this.makeScenario({...this.sim.settings},config);this.runId=randomUUID();this.settingsRevision++;
  }
  if(command.action==='settings'){
   if(!validSettings(command.settings)){const error=new Error('参数名称、类型或范围无效');error.status=422;throw error;}
   if(Object.hasOwn(command.settings,'behaviorMode')&&command.settings.behaviorMode!==routingMode(this.sim.departureScenario)){const error=new Error('选路规则随出发模式自动切换，不能单独调整。');error.status=422;throw error;}
   this.sim.setSettings(command.settings||{});this.settingsRevision++;
  }
  if(command.action==='play'){if(typeof command.running!=='boolean')throw new Error('播放参数无效');this.running=command.running;}
  if(command.action==='speed'){if(![1,4,8].includes(command.speed))throw new Error('速度参数无效');this.speed=command.speed;}
  if(command.action==='reset'||command.action==='preset'){
   const settings={...this.sim.settings,...(command.action==='preset'?{demand:command.preset==='peak'?30:12}:{})};
   this.sim=this.makeScenario(settings,command.action==='preset'?{mode:'fixed'}:this.sim.departureScenario);this.runId=randomUUID();this.settingsRevision++;
  }
  if(command.action==='demo'){this.sim=createOvertakingDemo(scenarioSettings(this.sim.settings,{mode:'fixed'}));this.runId=randomUUID();this.settingsRevision++;this.running=true;this.speed=1;}
  this.changed();return this.packet();
 }
}
