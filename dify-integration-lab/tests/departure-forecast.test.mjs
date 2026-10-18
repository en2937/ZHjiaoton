import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {SharedSimulation} from '../../traffic-sandbox/shared-simulation.mjs';
import {Simulation} from '../../traffic-sandbox/dist/engine.mjs';
import {journeyRefs,journeyLength} from '../../traffic-sandbox/student-data.mjs';
import {departureIntent} from '../departure-intent.mjs';
import {forecastInput,createDepartureForecaster} from '../departure-forecast.mjs';
import {simulateDeparture,measureJourney} from '../departure-forecast-worker.mjs';
import {ForecastSimulation} from '../forecast-simulation.mjs';
const trip={origin:'1',destination:'2',mode:'electric'};
const intent=departureIntent('我想去东教上早八，我几点出发最好？',trip);
const packet=()=>new SharedSimulation({running:false}).packet();
const route={id:'main',name:'主路',baseId:'1-south',refs:journeyRefs('1','main')};
test('自然语言时刻解析：早八、点半、24小时及下午课堂',()=>{
 for(const [q,time] of [['我想去东教上早八，我几点出发最好？','08:00'],['早八点半上课，何时动身？','08:30'],['10:00上课，几点出发？','10:00'],['下午两点上课，几点出发？','14:00'],['晚八上课，何时走？','20:00']])assert.equal(departureIntent(q,trip).classTime,time);
 assert.equal(intent.bufferMinutes,5);assert.equal(intent.trip.destination,'2');
});
test('缺时刻、非法时间、步行和未知目的地不产生假预测',()=>{
 for(const q of ['几点出发最好？','25:00上课几点出发？','8:70上课几点出发？'])assert.equal(departureIntent(q,trip).kind,'need_clarification');
 assert.equal(departureIntent('去西教上早八几点出发？',trip).kind,'missing_data');
 assert.equal(departureIntent('走路去东教上早八几点出发？',trip).kind,'missing_data');
 assert.equal(departureIntent('哪条路更快？',trip),null);
 assert.equal(departureIntent('上早八几点出发？',{...trip,origin:'2'}).kind,'need_clarification');
 assert.equal(departureIntent('从宿舍去东教上早八几点出发？',{...trip,origin:'2'}).trip.origin,'1');
});
test('只传递场景参数与种子，缺数据/演示模式拒绝推演',()=>{
 const p=packet(),input=forecastInput(p,intent,'time');assert(!('cars'in input));assert(!('time'in input));assert.deepEqual(input.settings,p.simulation.settings);
 for(const bad of [{...p,source:'fixture'},{...p,settingsRevision:undefined},{...p,simulation:{...p.simulation,demo:true}}])assert.throws(()=>forecastInput(bad,intent,'time'),e=>e.code==='sandbox_unavailable');
});
test('真实引擎可重复，逐分钟最晚方案提前5分钟到达，源参数不变',()=>{
 const p=packet(),before=structuredClone(p),input={...forecastInput(p,intent,'time'),totalPeople:72,settings:{...p.simulation.settings,demand:12,motorDemand:2,northDemand:1}};
 const a=simulateDeparture(input),b=simulateDeparture(input);delete a.computeMs;delete b.computeMs;
 assert.deepEqual(a,b);assert.deepEqual(structuredClone(p),before);assert.equal(a.status,'ok');assert.equal(a.forecastSettings.behaviorMode,'grouped');
 assert(a.recommendation.arrivalSeconds<=8*3600-300+.01);assert.equal(Math.round(a.recommendation.departureSeconds)%60,0);
 const theoreticalLatest=Math.floor((3300-Math.min(...['main','roundabout','roundabout-north'].map(id=>journeyLength(journeyRefs('1',id))/8.4)))/60);
 assert(a.evaluatedTrials>=3*Math.round(theoreticalLatest-(a.recommendation.departureSeconds-7*3600)/60)+1);assert.equal(a.latestProvenAtGrid,true);
});
test('Worker道路索引与原引擎在混合车流、跨路段和问卷高峰逐字段一致',()=>{
 for(const mode of ['fixed','survey']){
  const options={settings:{demand:29,motorDemand:6,northDemand:8,northBypassShare:95,behaviorMode:mode==='survey'?'grouped':'original',guidanceCoverage:55},departureScenario:{mode,classTime:'08:00',totalPeople:360}};
  const a=new Simulation(options),b=new ForecastSimulation(options);
  for(let i=0;i<42;i++){a.step(60);b.step(60);assert.deepEqual(structuredClone(b),structuredClone(a));}
 }
});
test('入口堵塞时不能跳过队列，截止前未入场不输出到达；试行不改原快照',()=>{
 const sim=new Simulation({departureScenario:{mode:'survey',classTime:'08:00',totalPeople:1}});sim.cars=[];sim.pending={1:[],'-1':[],0:[]};
 for(const lane of [0,1,2]){const c=sim.newCar(1,0,'electric','1-south');c.lane=lane;c.homeLane=lane;c.v=0;c.maxV=0;sim.cars.push(c);}
 const before=structuredClone(sim);assert.equal(measureJourney(sim,route,{trip,goal:5}),null);assert.deepEqual(structuredClone(sim),before);
});
test('入口已有车辆排队时，用时包含入场等待并到达标记目的地',()=>{
 const sim=new Simulation({departureScenario:{mode:'survey',classTime:'08:00',totalPeople:1}});sim.cars=[];sim.pending={1:[],'-1':[],0:[]};
 for(let i=0;i<20;i++)sim.pending[1].push(sim.newCar(1,0,'electric','1-south'));
 const result=measureJourney(sim,route,{trip,goal:3300});assert(result);assert(result.entryWaitSeconds>5);assert(result.travelTimeSeconds>journeyLength(route.refs)/8.4);assert.equal(result.distanceMeters,1200);
});
test('自行车及反向行程按各自模型推演',()=>{
 const p=packet(),input={...forecastInput(p,intent,'time'),totalPeople:36,settings:{...p.simulation.settings,demand:4,motorDemand:0,northDemand:0}};
 const bike=simulateDeparture({...input,trip:{...trip,mode:'bicycle'}}),reverse=simulateDeparture({...input,trip:{origin:'2',destination:'1',mode:'electric'}});
 assert.equal(bike.status,'ok');assert.equal(reverse.status,'ok');for(const r of [bike,reverse])assert(r.recommendation.arrivalSeconds<=28500.01);
});
function fakeWorker(){const w=new EventEmitter();w.terminate=()=>{w.terminated=true;};return w;}
test('同场景并发合并、其他请求限流、缓存防篡改及参数变化失效',async()=>{
 const workers=[],p=packet(),f=createDepartureForecaster({workerFactory:()=>{const w=fakeWorker();workers.push(w);return w;}});
 const first=f.run(p,intent,'time'),same=f.run(p,intent,'time');assert.equal(workers.length,1);
 await assert.rejects(f.run(p,{...intent,classTime:'10:00'},'time'),e=>e.code==='forecast_busy');
 workers[0].emit('message',{ok:true,result:{status:'ok',recommendation:{departureTime:'07:50'}}});const a=await first,b=await same;assert.deepEqual(a,b);a.recommendation.departureTime='bad';
 const cached=await f.run(p,intent,'time');assert.equal(cached.cacheHit,true);assert.equal(cached.recommendation.departureTime,'07:50');
 const changed=f.run({...p,settingsRevision:p.settingsRevision+1},intent,'time');assert.equal(workers.length,2);workers[1].emit('message',{ok:true,result:{status:'no_feasible_departure'}});await changed;f.dispose();
});
test('缓存到期重算，后台异常及超时明确返回并清理任务',async()=>{
 let clock=0;const workers=[],f=createDepartureForecaster({timeoutMs:30,cacheTtlMs:100,now:()=>clock,workerFactory:()=>{const w=fakeWorker();workers.push(w);return w;}}),p=packet();
 let a=f.run(p,intent,'time');workers[0].emit('message',{ok:true,result:{status:'ok'}});await a;clock=101;
 a=f.run(p,intent,'time');workers[1].emit('error',new Error('private stack'));await assert.rejects(a,e=>e.code==='forecast_failed'&&!e.message.includes('private'));
 a=f.run(p,intent,'time');await assert.rejects(a,e=>e.code==='forecast_timeout');assert(workers[2].terminated);f.dispose();
});
test('异步任务立即返回，轮询不重复启动，参数变化使旧任务失效',async()=>{
 const workers=[],p=packet(),f=createDepartureForecaster({workerFactory:()=>{const w=fakeWorker();workers.push(w);return w;}});
 const start=f.request(p,intent,'time');assert.equal(start.status,'pending');assert.equal(f.request(p,intent,'time',start.jobId).jobId,start.jobId);assert.equal(workers.length,1);
 assert.throws(()=>f.request({...p,settingsRevision:p.settingsRevision+1},intent,'time',start.jobId),e=>e.code==='forecast_stale');
 workers[0].emit('message',{ok:true,result:{status:'ok',recommendation:{departureTime:'07:50'}}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.request(p,intent,'time',start.jobId).status,'complete');assert.equal(workers.length,1);f.dispose();
});
