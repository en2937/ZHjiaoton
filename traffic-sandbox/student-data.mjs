import {Simulation,roadGeometry,WAIT_SPEED} from './dist/engine.mjs';
import {ROUTES,APPROACHES} from './dist/route.mjs';
export const places=[{id:'1',name:'云峰学园（1）'},{id:'2',name:'东教学楼（2）'}];
export const modes=[{id:'electric',name:'电动车',available:true},{id:'bicycle',name:'自行车',available:true},
 {id:'walking',name:'步行',available:false,reason:'沙盘尚未建立步行模型'}];
const sourceRoutes={1:[['main','主路','1-south'],['roundabout','环岛','1-ring'],['roundabout-north','北侧环岛线','1-ring-north']],
 2:[['main','主路','2-west-north'],['roundabout','环岛','2-ring'],['roundabout-north','北侧环岛线','2-ring-north']]};
export function journeyRefs(origin,id){
 const entry=sourceRoutes[origin]?.find(row=>row[0]===id);if(!entry)return null;
 const refs=ROUTES[entry[2]].refs.slice(0,-1).map(ref=>({...ref}));
 // Destination 1 is the marked source, rather than the NW map exit.
 if(String(origin)==='2')refs.push({edge:'access1',direction:-1});
 return refs;
}
export const journeyLength=refs=>refs.reduce((sum,ref)=>sum+roadGeometry[ref.edge].length,0);
// Approximate main-road distance supplied by the user, not a map survey.
export const calibration={reference:'主路 1 → 2',referenceMeters:1200,source:'user-approximation',
 metersPerMapUnit:1200/journeyLength(journeyRefs('1','main'))};
export function studentStateFromSandbox(packet,{origin='1',destination='2',mode='electric'}={}){
 if(!places.some(p=>p.id===origin)||!places.some(p=>p.id===destination)||!modes.some(m=>m.id===mode))return null;
 if(packet?.source!=='synthetic-simulation'||!packet.simulation?.settings||!Array.isArray(packet.simulation.cars))throw new Error('沙盘状态格式不匹配');
 const sim=Object.assign(Object.create(Simulation.prototype),packet.simulation);
 const available=mode!=='walking'&&!sim.demo;
 const routes=origin===destination||!available?[]:sourceRoutes[origin].map(([id,name])=>{
  const refs=journeyRefs(origin,id),distance=journeyLength(refs),freeFlow=distance/{electric:8.4,bicycle:6.8}[mode];
  let wait=0;const junctions=[];
  for(const ref of refs){
   const approach=APPROACHES.find(a=>a.edge===ref.edge&&a.direction===ref.direction);if(!approach)continue;
   const queued=sim.cars.filter(c=>c.route.refs[c.edgeIndex]?.edge===ref.edge&&c.route.refs[c.edgeIndex]?.direction===ref.direction&&c.queueJunction===approach.j&&c.v<WAIT_SPEED);
   const control=sim.control(approach.j,approach.controlDirection??(approach.origin===1?1:-1));
   // Snapshot estimate, not a prediction of traffic at the future arrival time.
   const queueWait=queued.reduce((sum,c)=>sum+(c.kind==='motor'?1.6:1.2),0),signalWait=control.open?0:control.remaining;
   wait+=queueWait+signalWait;
   junctions.push({id:approach.j===0?'west':'east',queued:queued.length,signalColor:control.color,signalWaitSeconds:signalWait,queueServiceSeconds:Number(queueWait.toFixed(1))});
  }
  return {id,name,origin,destination,mode,travelTimeSeconds:Math.ceil(freeFlow+wait),
   distanceMeters:Math.round(distance*calibration.metersPerMapUnit/10)*10,distanceMapUnits:Number(distance.toFixed(1)),
   freeFlowSeconds:Number(freeFlow.toFixed(1)),estimatedWaitSeconds:Number(wait.toFixed(1)),junctions,
   timeMethod:'current-state-rule-estimate',distanceApproximate:true};
 });
 return {schemaVersion:'campus-student-v1',scenarioId:'shared-traffic-sandbox',source:'traffic-sandbox-live',
  sourceLabel:'已连接沙盘 · 合成仿真数据',stateVersion:packet.stateVersion,runId:packet.runId,
  clock:sim.clockState(),departureScenario:sim.departureState(),updatedAt:packet.updatedAt,readAt:new Date().toISOString(),simulationTimeSeconds:sim.time,running:packet.running,
  origin,destination,mode,routes,settings:{...sim.settings},metrics:sim.metrics(),calibration,
  unavailableReason:sim.demo?'当前是并排超车展示，请在沙盘重置后比较路线。':mode==='walking'?'沙盘尚未建立步行模型，暂时没有步行路线数据。':null,
  limitations:['用时为自由行驶时间加当前信号等待和队列服务时间的规则估计，未预测抵达时的未来车流',
   '距离按用户提供的主路 1→2 约 1.2 公里及地图长度比例换算，属于估算','车速为模拟设定，尚未实地标定','未提供未来出发时段的预测']};
}
