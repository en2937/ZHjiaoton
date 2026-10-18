import {parentPort,workerData} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {roadGeometry,currentRef,classSeconds,formatSimulationClock} from '../traffic-sandbox/dist/engine.mjs';
import {journeyRefs,journeyLength,calibration,studentStateFromSandbox} from '../traffic-sandbox/student-data.mjs';
import {ROUTES} from '../traffic-sandbox/dist/route.mjs';
import {ForecastSimulation} from './forecast-simulation.mjs';
import {AVOIDANCE_POLICY,FORECAST_MODEL_VERSION,selectAvoidance} from './departure-objectives.mjs';
import {applyPeriodProfile,periodProfile} from './departure-periods.mjs';
const routes={1:[['main','主路','1-south'],['roundabout','环岛','1-ring'],['roundabout-north','北侧环岛线','1-ring-north']],2:[['main','主路','2-west-north'],['roundabout','环岛','2-ring'],['roundabout-north','北侧环岛线','2-ring-north']]};
export function measureJourney(snapshot,route,{trip,goal,check=()=>{}}){
 check();const sim=Object.assign(Object.create(ForecastSimulation.prototype),structuredClone(snapshot)),departure=sim.time,speed={electric:8.4,bicycle:6.8}[trip.mode];
 // A counterfactual rider must not consume the background traffic's random sequence.
 const saved={seed:sim.seed,nextId:sim.nextId,studentOrdinal:sim.studentOrdinal,bypassStats:structuredClone(sim.bypassStats)};
 const rider=sim.newCar(trip.origin==='1'?1:-1,sim.time,trip.mode,route.baseId);Object.assign(sim,saved);
 rider.id=-1;rider.maxV=speed;rider.lane=1;rider.homeLane=1;rider.route={...ROUTES[route.baseId],id:'forecast-'+route.id,refs:route.refs};rider.routingChoice=null;
 sim.pending[rider.direction].push(rider);sim.watchVehicle?.(rider);let enteredAt=null;
 const remainingFrom=route.refs.map((_,i)=>route.refs.slice(i+1).reduce((n,ref)=>n+roadGeometry[ref.edge].length,0));
 while(sim.time<goal-1e-7){check();
  const remaining=remainingFrom[rider.edgeIndex]+Math.max(0,roadGeometry[currentRef(rider).edge].length-rider.p);
  // Even driving at maximum speed cannot recover this deadline. This is a lower
  // bound, so pruning changes neither feasible arrivals nor the simulation step.
  if(sim.time+remaining/speed>goal+1e-5)return null;
  sim.step(Math.min(.5,goal-sim.time));
  if(enteredAt===null&&(sim.hasVehicle?.(rider)??sim.cars.includes(rider)))enteredAt=sim.time;
  if(rider.edgeIndex===route.refs.length-1&&rider.p>=roadGeometry[currentRef(rider).edge].length-1e-6){
   const start=classSeconds(sim.departureScenario.classTime)-3600,departureSeconds=start+departure,arrivalSeconds=start+sim.time;
   const elapsed=sim.time-departure,freeFlowSeconds=journeyLength(route.refs)/speed;
   return {id:route.id,name:route.name,departureSeconds,arrivalSeconds,departureTime:formatSimulationClock(departureSeconds,false),arrivalTime:formatSimulationClock(Math.ceil(arrivalSeconds/60)*60,false),travelTimeSeconds:Math.ceil(elapsed),entryWaitSeconds:Math.ceil((enteredAt??sim.time)-departure),signalAndQueueWaitSeconds:Math.ceil(rider.totalWait),freeFlowSeconds:Number(freeFlowSeconds.toFixed(2)),delaySeconds:Math.ceil(Math.max(0,elapsed-freeFlowSeconds)),distanceMeters:Math.round(journeyLength(route.refs)*calibration.metersPerMapUnit/10)*10};
  }
  if(!(sim.hasVehicle?.(rider)??sim.cars.includes(rider))&&!sim.pending[rider.direction].includes(rider))return null;
 }
 return null;
}
export function simulateDeparture(input){
 const started=performance.now(),budget=input.budgetMs??179000,check=()=>{if(performance.now()-started>budget)throw Object.assign(new Error('推演未在时限内完成，请稍后再试。'),{code:'forecast_timeout'});};
 const {trip,classTime,bufferMinutes=5}=input,speed={electric:8.4,bicycle:6.8}[trip.mode];
 if(!speed||!routes[trip.origin]||trip.origin===trip.destination||!['1','2'].includes(trip.destination))throw Error('Unsupported forecast trip');
 const config={mode:'survey',classTime,totalPeople:input.totalPeople??360,seed:input.departureSeed??20261014,distributionModel:input.distributionModel??'smooth-peaks-v1',observationTime:null};
 const settings={...input.settings,behaviorMode:'grouped'},seed=input.initialSeed??20261012;
 const candidates=routes[trip.origin].map(([id,name,baseId])=>({id,name,baseId,refs:journeyRefs(trip.origin,id)}));
 const goal=3600-bufferMinutes*60,latest=Math.floor((goal-Math.min(...candidates.map(r=>journeyLength(r.refs)/speed)))/60);
 if(latest<0)return {status:'no_feasible_departure',reason:'时间窗口内没有满足提前到达条件的出发时刻。'};
 const baseline=new ForecastSimulation({seed,settings,departureScenario:config}),profile=applyPeriodProfile(baseline,input.periodProfile??periodProfile(classTime)),snapshots=[];
 for(let minute=0;minute<=latest;minute++){check();if(minute)baseline.step(60);snapshots.push(structuredClone(baseline));}
 const trials=new Map();
 const trial=(minute,route)=>{const key=minute+':'+route.id;if(!trials.has(key)){check();trials.set(key,measureJourney(snapshots[minute],route,{trip,goal,check}));}return trials.get(key);};
 const routeOrder=minute=>{const field=input.preference==='distance'?'distanceMeters':'travelTimeSeconds',estimates=studentStateFromSandbox({source:'synthetic-simulation',simulation:snapshots[minute]},trip).routes;return [...candidates].sort((a,b)=>estimates.find(r=>r.id===a.id)[field]-estimates.find(r=>r.id===b.id)[field]);};
 let latestResult=null;
 for(let minute=latest;minute>=0&&!latestResult;minute--)for(const route of routeOrder(minute)){latestResult=trial(minute,route);if(latestResult)break;}
 if(!latestResult)return {status:'no_feasible_departure',classTime,bufferMinutes,evaluatedTrials:trials.size,reason:'课前一小时内未找到预计能提前5分钟到达的出发方案。'};
 let recommendation=latestResult,search={method:'descending-minute-grid',minuteStep:1,latestProvenAtGrid:true};
 const avoid=input.goal==='avoid-congestion';
 if(avoid){
  // A fixed candidate grid keeps repeatability independent of machine speed.
  const minutes=new Set([latest]);for(let m=0;m<=latest;m+=AVOIDANCE_POLICY.coarseMinutes)minutes.add(m);
  for(const m of [...minutes].sort((a,b)=>a-b))for(const route of candidates)trial(m,route);
  const feasible=()=>[...trials.values()].filter(Boolean),coarseBest=selectAvoidance(feasible(),input.preference),center=Math.round((coarseBest.departureSeconds-(classSeconds(classTime)-3600))/60);
  for(const m of [center-AVOIDANCE_POLICY.refineMinutes,center+AVOIDANCE_POLICY.refineMinutes])if(m>=0&&m<=latest)for(const route of candidates)trial(m,route);
  recommendation=selectAvoidance(feasible(),input.preference);
  search={method:'fixed-coarse-and-refined-grid',coarseMinutes:AVOIDANCE_POLICY.coarseMinutes,refineMinutes:AVOIDANCE_POLICY.refineMinutes,refinedAroundMinute:center,nearMinimumSeconds:AVOIDANCE_POLICY.nearMinimumSeconds,globalMinimumProven:false};
 }
 const successful=[...trials.values()].filter(Boolean),comparison=avoid?{latestFeasible:latestResult,delayReductionSeconds:latestResult.delaySeconds-recommendation.delaySeconds,earlierDepartureMinutes:Math.round((latestResult.departureSeconds-recommendation.departureSeconds)/60)}:null;
 return {status:'ok',recommendation,timelyRoutes:successful.filter(r=>r.departureSeconds===recommendation.departureSeconds),classTime,bufferMinutes,gridMinutes:avoid?null:1,evaluatedTrials:trials.size,feasibleTrials:successful.length,latestProvenAtGrid:!avoid,objective:{id:avoid?'avoid-congestion':'latest-with-buffer',label:avoid?'避开拥堵':'尽量晚出发',metric:avoid?'extra-time-vs-free-flow':'latest-departure',delayIncludes:'入口等待、红灯、排队与慢行'},search,comparison,trialResults:avoid?successful:undefined,model:FORECAST_MODEL_VERSION,scenarioConfig:config,periodProfile:profile,forecastSettings:settings,initialSeed:seed,computeMs:Math.round(performance.now()-started),assumptions:['按当前参数重新构建该课堂课前一小时，不沿用管理员当前车流或模拟时钟','推演采用仿真模式和认知与意愿分组，其余参数沿用当前设置；未接入真实课表或天气','代表骑行者采用名义速度并遵守入口排队及路口信号，按推荐路线行驶',avoid?'避堵按固定抽样时刻比较等待与慢行耗时（含红灯），相差15秒内优先晚出发；不保证连续时间全局最优':'从晚向前逐分钟验证；同一分钟按快照估计排序，不保证该分钟内用时最短',profile.note,'固定种子的场景推演，不是准时保证','预留5分钟，停车、进楼及寻找教室时间未单独建模']};
}
if(parentPort){try{parentPort.postMessage({ok:true,result:simulateDeparture(workerData)});}catch(error){parentPort.postMessage({ok:false,error:error.code??'forecast_failed',message:error.message});}}
