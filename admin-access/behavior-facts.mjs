// Numeric statements are assembled from the same owner snapshot, never from model arithmetic.
export function validBehaviorAggregate(b){
 try{
  const n=v=>Number.isSafeInteger(v)&&v>=0,sum=o=>Object.values(o).reduce((a,v)=>a+v,0);
  if(!b||typeof b.enabled!=='boolean'||b.sampleSize!==36)return false;
  for(const g of [b.onMap,b.entryWaiting,b.eligible]){
   if(!n(g.count)||!n(g.guided)||!n(g.bypassSelected)||!n(g.bypassInherited)||!n(g.missingProfiles)||g.guided>g.count||g.bypassSelected>g.count||g.bypassInherited>g.bypassSelected)return false;
   for(const [groups,keys]of [[g.knowledge,['known','unknown','untried']],[g.willingness,['conditional','occasional','unwilling']]])if(Object.keys(groups).length!==3||!keys.every(k=>n(groups[k]))||sum(groups)+g.missingProfiles!==g.count)return false;
  }
  const e=b.eligible;
  const reasonKeys=['notAware','untriedWithoutGuide','notReached','unwilling','notEnoughSaving','trialNotTaken','strategyNotAssigned','missingProfile','notEvaluated'];
  return n(e.notBypassing)&&e.notBypassing+e.bypassSelected===e.count&&Object.keys(e.reasons).length===9&&reasonKeys.every(k=>n(e.reasons[k]))&&sum(e.reasons)===e.notBypassing&&n(b.ineligible.routeNotApplicable)&&n(b.ineligible.passedFork)&&sum(b.ineligible)+e.count===b.onMap.count&&Number.isFinite(b.assumptions.minimumSavingSeconds)&&Number.isFinite(b.assumptions.trialProbability.conditional)&&Number.isFinite(b.assumptions.trialProbability.occasional);
 }catch{return false;}
}
export function behaviorFacts(state){
 const b=state.behavior;if(!b)return null;
 const e=b.eligible,m=b.onMap,k=e.knowledge,w=e.willingness;
 const reasons={notAware:'未获知路线',untriedWithoutGuide:'知道但未尝试且没有引导',notReached:'未触达',unwilling:'不愿尝试',notEnoughSaving:'当前估算节省不足',trialNotTaken:'未触发试用',strategyNotAssigned:'未被策略选中',missingProfile:'属性缺失',notEvaluated:'未评估'};
 const f={eligible:`当前地图内、合法可绕行且尚未过分岔点的学生车辆${e.count}辆，其中已获引导${e.guided}辆、选择绕行${e.bypassSelected}辆`,
  knowledge:`上述可绕行学生的初始认知分组为知道路线${k.known}辆、不知道${k.unknown}辆、知道但未尝试${k.untried}辆；当前获引导情况另列`,
  willingness:`上述可绕行学生中，愿意尝试且更快后倾向继续${w.conditional}辆、愿意但不常走${w.occasional}辆、不愿尝试${w.unwilling}辆`,
  onMap:`当前地图内学生车辆${m.count}辆，其中已获引导${m.guided}辆、选择绕行${m.bypassSelected}辆；绕行中由切换前规则沿用${m.bypassInherited}辆`,
  entryWaiting:`当前入口等待学生车辆${b.entryWaiting.count}辆，未计入地图内人数`,
  ineligible:`当前地图内学生中，路线不适用${b.ineligible.routeNotApplicable}辆、已过分岔点${b.ineligible.passedFork}辆`,
  queues:`当前A队列${state.metrics.queues[0].total}辆、B队列${state.metrics.queues[1].total}辆`,
  strategy:`北侧绕行策略目标${state.settings.northBypassShare}%，引导覆盖设定${state.settings.guidanceCoverage}%；两者都不等于实际绕行比例`,
  scope:`当前全部在途车辆${state.metrics.active}辆，其中机动车${state.metrics.motor}辆；分组只用于地点一、二学生骑行车辆`,
  survey:'调查样本36份；认知原始人数18/14/4，意愿原始人数32/2/2；不是全校使用率或实际引导接受率',
  measuredBenefit:'尝试后的实测收益尚未统计',
  savingRule:`模拟试用门槛为估计至少节省${b.assumptions.minimumSavingSeconds}秒，条件继续组试用概率${b.assumptions.trialProbability.conditional}、不常用组${b.assumptions.trialProbability.occasional}；均为假设`};
 for(const [key,label]of Object.entries(reasons))f[key]=`上述未绕行学生的互斥原因中，${label}${e.reasons[key]}辆`;
 const topReasons=Object.entries(reasons).filter(([key])=>e.reasons[key]>0).sort((a,z)=>e.reasons[z[0]]-e.reasons[a[0]]).slice(0,3);
 f.primaryReasons=topReasons.length?`上述未选绕行学生${e.notBypassing}辆，主要可统计原因是${topReasons.map(([key,label])=>label+e.reasons[key]+'辆').join('、')}`:'上述可绕行学生当前没有未选绕行者';
 for(const [key,routes]of Object.entries(state.routes)){
  const main=routes.find(r=>r.id==='main'),north=routes.find(r=>r.id==='roundabout-north');if(!main||!north)continue;
  const saving=main.travelTimeSeconds-north.travelTimeSeconds;
  f['journey_'+key]=`地点${main.origin}→${main.destination}${main.mode==='electric'?'电动车':'自行车'}：主路当前估算${main.travelTimeSeconds}秒、约${main.distanceMeters}米；北侧线${north.travelTimeSeconds}秒、约${north.distanceMeters}米，当前估计${saving>=0?'节省':'多用'}${Math.abs(saving)}秒；不是未来预测或实测收益`;
 }
 return f;
}
