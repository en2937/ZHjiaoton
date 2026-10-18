import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Simulation} from '../../traffic-sandbox/dist/engine.mjs';
import {SharedSimulation} from '../../traffic-sandbox/shared-simulation.mjs';
import {departureIntent} from '../departure-intent.mjs';
import {selectAvoidance,forecastMessage} from '../departure-objectives.mjs';
import {periodProfile,warpMinute,applyPeriodProfile} from '../departure-periods.mjs';
import {forecastInput,createDepartureForecaster} from '../departure-forecast.mjs';
import {simulateDeparture} from '../departure-forecast-worker.mjs';
const trip={origin:'1',destination:'2',mode:'electric'};
test('识别避开拥堵、错峰、不想被堵，与默认最晚出发及否定语句区分',()=>{
 for(const question of ['我十点上课，想避开拥堵，大概几点出发','10:00上课，想错峰','早八不想被堵，几点动身？'])assert.equal(departureIntent(question,trip).goal,'avoid-congestion');
 for(const question of ['早八几点出发最好？','十点上课，不需要避开拥堵，几点出发？'])assert.equal(departureIntent(question,trip).goal,'latest-with-buffer');
 assert.equal(departureIntent('现在想避开拥堵走哪条路？',trip),null);
});
test('早八集中、十点分散，同人数、同种子、同路网；分时模板不冒充问卷事实',()=>{
 const a=new Simulation({departureScenario:{mode:'survey',classTime:'08:00',totalPeople:360}}),b=new Simulation({departureScenario:{mode:'survey',classTime:'10:00',totalPeople:360}}),ids=a.surveyDepartures.plan.map(e=>e.id).sort((x,y)=>x-y);
 const early=applyPeriodProfile(a),later=applyPeriodProfile(b);
 assert(early.standardDeviationMinutes<later.standardDeviationMinutes);assert.notDeepEqual(early.plannedByMinute,later.plannedByMinute);
 for(const [sim,profile]of [[a,early],[b,later]]){assert.equal(profile.totalPeople,360);assert.equal(profile.plannedByMinute.reduce((n,v)=>n+v,0),360);assert.deepEqual(sim.surveyDepartures.plan.map(e=>e.id).sort((x,y)=>x-y),ids);assert(sim.surveyDepartures.plan.every(e=>e.time>=0&&e.time<3600));assert.equal(profile.basis,'user-approved-simulation-assumption');assert.match(profile.note,/不是分时实测/);}
 assert.equal(a.seed,b.seed);assert.deepEqual(a.settings,b.settings);
});
test('时间变换平滑单调且端点不变；相同种子的计划可重复',()=>{
 for(const time of ['08:00','10:00','14:00']){const p=periodProfile(time);assert.equal(warpMinute(0,p),0);assert.equal(warpMinute(60,p),60);let previous=-1;for(let i=0;i<=600;i++){const v=warpMinute(i/10,p);assert(v>previous);previous=v;}}
 const setup=()=>{const sim=new Simulation({departureScenario:{mode:'survey',classTime:'10:00',totalPeople:72}});const profile=applyPeriodProfile(sim);return {plan:sim.surveyDepartures.plan,profile};};assert.deepEqual(setup(),setup());
});
test('避堵先比较等待慢行，15秒近似并列时优先晚出发；不把最晚当避堵',()=>{
 const rows=[{departureSeconds:3000,delaySeconds:180,distanceMeters:1200,arrivalSeconds:3290},{departureSeconds:2400,delaySeconds:35,distanceMeters:1320,arrivalSeconds:2800},{departureSeconds:2700,delaySeconds:47,distanceMeters:1320,arrivalSeconds:3100}];
 assert.equal(selectAvoidance(rows).departureSeconds,2700);assert.equal(selectAvoidance([]),null);
 const msg=forecastMessage({classTime:'10:00',objective:{id:'avoid-congestion'},recommendation:{departureTime:'09:40',arrivalTime:'09:47',name:'主路'}},'东教学楼');assert.match(msg,/减少等待与慢行/);assert.match(msg,/东教学楼/);
});
test('目标与时段参数进入缓存指纹，不能复用同一时刻的另一目标结果',async()=>{
 const p=new SharedSimulation({running:false}).packet(),workers=[],f=createDepartureForecaster({workerFactory:()=>{const w=new EventEmitter();w.terminate=()=>{};workers.push(w);return w;}}),latest=departureIntent('十点上课，几点出发？',trip),avoid=departureIntent('十点上课想避开拥堵，几点出发？',trip);
 const a=f.run(p,latest,'time');workers[0].emit('message',{ok:true,result:{status:'ok'}});const first=await a;
 const b=f.run(p,avoid,'time');assert.equal(workers.length,2);workers[1].emit('message',{ok:true,result:{status:'ok'}});const second=await b;assert.notEqual(first.fingerprint,second.fingerprint);f.dispose();
 const input=forecastInput(p,avoid,'time');assert.equal(input.goal,'avoid-congestion');assert.equal(input.periodProfile.factor,1.2);
});
test('真实引擎两种目标都提前到达，避堵比较独立候选且重复可得相同结果',()=>{
 const p=new SharedSimulation({running:false,settings:{demand:4,motorDemand:0,northDemand:0}}).packet(),intent=departureIntent('十点上课想避开拥堵，几点出发？',trip),input={...forecastInput(p,intent,'time'),totalPeople:36};
 const a=simulateDeparture(input),b=simulateDeparture(input);delete a.computeMs;delete b.computeMs;assert.deepEqual(a,b);assert.equal(a.status,'ok');assert.equal(a.objective.id,'avoid-congestion');assert.equal(a.latestProvenAtGrid,false);assert.equal(a.search.globalMinimumProven,false);assert(a.recommendation.arrivalSeconds<=35700.01);
 assert(a.recommendation.delaySeconds<=a.comparison.latestFeasible.delaySeconds);assert(a.comparison.earlierDepartureMinutes>=0);assert(a.trialResults.length>5);assert(a.periodProfile.factor===1.2);
 const minimum=Math.min(...a.trialResults.map(r=>r.delaySeconds));assert(a.recommendation.delaySeconds<=minimum+15);assert(a.trialResults.filter(r=>r.delaySeconds<=minimum+15).every(r=>r.departureSeconds<=a.recommendation.departureSeconds+.01));
});
