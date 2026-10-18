import {knowledgePolicy,canonicalQuestion} from '../qa-policy/knowledge-scope.mjs';
// All route values below are invented interface samples, not measured campus
// distances or output from traffic-sandbox. Replace this adapter after handoff.
export const studentPlaces = [{id:'1',name:'地点 1'},{id:'2',name:'地点 2'}];
export const studentModes = [{id:'electric',name:'电动车'},{id:'bicycle',name:'自行车'},{id:'walking',name:'步行'}];

export function studentState({origin='1',destination='2',mode='electric',fixtureId='A'}={}) {
  if (!studentPlaces.some(p=>p.id===origin) || !studentPlaces.some(p=>p.id===destination) ||
      !studentModes.some(m=>m.id===mode) || !['A','B'].includes(fixtureId)) return null;
  const times={A:{electric:[300,180],bicycle:[420,300],walking:[660,840]},B:{electric:[160,260],bicycle:[260,340],walking:[660,840]}}[fixtureId][mode];
  return {
    schemaVersion:'campus-student-v1',scenarioId:'student-interface-demo',
    stateVersion:'student-fixture-'+fixtureId+'-'+origin+'-'+destination+'-'+mode,
    source:'handcrafted-integration-fixture',sourceLabel:'演示数据 · 尚未连接沙盘',
    updatedAt:new Date().toISOString(),origin,destination,mode,
    routes:origin===destination?[]:[
      {id:'main',name:'主路',origin,destination,mode,travelTimeSeconds:times[0],distanceMeters:850},
      {id:'roundabout',name:'环岛',origin,destination,mode,travelTimeSeconds:times[1],distanceMeters:1100},
    ],
    limitations:['时间、米制距离均为人工演示设定，未实地标定','未提供未来时段预测'],
  };
}

export function futureQuestion(question) {
  return /未来|明天|后天|稍后|(?:分钟|小时|天)后|过\s*[0-9一二三四五六七八九十百几]+\s*(?:分钟|小时)|\b(tomorrow|later|next\s+hour)\b/iu.test(question);
}

export function studentEnvelope(question,state,preference) {
  const compact={schemaVersion:state.schemaVersion,stateVersion:state.stateVersion,runId:state.runId,
    source:state.source,origin:state.origin,destination:state.destination,mode:state.mode,
    routes:state.routes.map(({id,name,travelTimeSeconds,distanceMeters})=>({id,name,travelTimeSeconds,distanceMeters})),limitations:state.limitations};
  return JSON.stringify({protocol:'campus-student-v1',question:canonicalQuestion(question),originalQuestion:question,state:compact,knowledgePolicy:knowledgePolicy('student'),
    preference,outputFormat:{status:'ok | missing_data | out_of_scope',criterion:'time | distance',recommended_route_id:state.routes.map(r=>r.id).join(' | ')+' | null'},
    instruction:'师生端只要路线选择，不要长解释。只返回所约定的JSON；时间和距离由网页读取本轮state显示。问题中的明确时间/距离偏好优先于preference。未提供目的地或未来数据时不能借用其他线路。'});
}

export function parseStudentReply(text,state) {
  let raw=String(text).trim();
  if (raw.startsWith('```')) raw=raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  let result;
  try {result=JSON.parse(raw);} catch {return null;}
  if(!result||typeof result!=='object'||Array.isArray(result))return null;
  if (!['ok','missing_data','out_of_scope'].includes(result.status)) return null;
  if (result.status!=='ok') return {status:result.status,criterion:null,recommendedRouteId:null};
  if (!['time','distance'].includes(result.criterion) || !state.routes.some(r=>r.id===result.recommended_route_id)) return null;
  const field=result.criterion==='distance'?'distanceMeters':'travelTimeSeconds';
  const selected=state.routes.find(r=>r.id===result.recommended_route_id);
  if (selected[field]!==Math.min(...state.routes.map(r=>r[field]))) return null;
  return {status:'ok',criterion:result.criterion,recommendedRouteId:selected.id};
}

export function routeComparison(state) {
  const routes=state.routes;
  if(routes.length<2)return null;
  const byTime=[...routes].sort((a,b)=>a.travelTimeSeconds-b.travelTimeSeconds);
  const byDistance=[...routes].sort((a,b)=>a.distanceMeters-b.distanceMeters);
  return {fastestRouteId:byTime[0].id,shortestRouteId:byDistance[0].id,
    timeDifferenceSeconds:byTime.at(-1).travelTimeSeconds-byTime[0].travelTimeSeconds,
    distanceDifferenceMeters:byDistance.at(-1).distanceMeters-byDistance[0].distanceMeters};
}
