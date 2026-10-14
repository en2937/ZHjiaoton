// Dify Code 节点：输入 query=sys.query, model_output=LLM.text；输出 output_json:string。
// 此节点只验证/生成指令，不调用任何沙盘控制接口。
function legacyMain({query, model_output}) {
  const protocol = 'campus-admin-v1';
  const ranges = {demand:[4,50], motorDemand:[0,20], northDemand:[0,20], electric:[0,100], outbound:[20,80], northBypassShare:[0,100]};
  const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
  const object = o => o !== null && typeof o === 'object' && !Array.isArray(o);
  const validPatch = p => object(p) && Object.entries(p).every(([k,v]) => k === 'westSignalMode' ? ['adaptive','fixed'].includes(v) : own(ranges,k) && typeof v === 'number' && Number.isFinite(v) && v >= ranges[k][0] && v <= ranges[k][1]);
  let envelope, state;
  const fail = (status, reply) => ({output_json:JSON.stringify({protocol,status,intent:'inspect',state_version:typeof state?.stateVersion==='string'?state.stateVersion:null,reply,changes:{},suggested_settings:{},evidence:[]})});
  try { envelope=JSON.parse(query); state=envelope.state; } catch { return fail('missing_data','暂无当前沙盘数据，请先连接沙盘再提问。'); }
  if(envelope.protocol!==protocol || !object(state) || state.source!=='synthetic-simulation' || typeof state.stateVersion!=='string' || !state.stateVersion || typeof state.runId!=='string' || !state.runId || !validPatch(state.settings) || Object.keys(state.settings).length!==7 || !object(state.metrics)) return fail('missing_data','暂无完整的当前沙盘数据，请重新读取状态。');
  let result;
  try { const fenced=/^\s*```(?:json)?\s*(\{[\s\S]*\})\s*```\s*$/i.exec(model_output);result=JSON.parse(fenced?fenced[1]:model_output); } catch { return fail('invalid_request','AI返回格式未通过校验，请重新提问；参数未改变。'); }
  const keys=['protocol','status','intent','state_version','reply','changes','suggested_settings','evidence'];
  if(!object(result) || Object.keys(result).length!==keys.length || !keys.every(k=>own(result,k)) || result.protocol!==protocol || result.state_version!==state.stateVersion || !['ok','need_clarification','missing_data','invalid_request','out_of_scope'].includes(result.status) || !['inspect','set','suggest','apply_proposal'].includes(result.intent) || typeof result.reply!=='string' || !result.reply.trim() || result.reply.length>1000 || !validPatch(result.changes) || !validPatch(result.suggested_settings) || !Array.isArray(result.evidence) || result.evidence.length>8) return fail('invalid_request','AI返回内容未通过校验，请重新提问；参数未改变。');
  for(const path of result.evidence) {
    if(typeof path!=='string' || !/^(settings|metrics)(\.[A-Za-z0-9_]+)+$/.test(path)) return fail('invalid_request','AI引用了无法核对的状态，请重新提问。');
    let value=state;
    for(const key of path.split('.')) { if(value===null || typeof value!=='object' || !own(value,key)) return fail('invalid_request','AI引用了不存在的状态，请重新提问。'); value=value[key]; }
  }
  const changes=Object.keys(result.changes).length, suggestions=Object.keys(result.suggested_settings).length;
  if(result.status!=='ok' && (changes || suggestions) || !['set','apply_proposal'].includes(result.intent) && changes || result.intent!=='suggest' && suggestions) return fail('invalid_request','AI操作类型与参数不一致，参数未改变。');
  if(result.status==='ok' && result.intent==='apply_proposal') {
    const p=envelope.context?.pendingProposal;
    const baseMatches=p && p.runId===state.runId && object(p.baseSettings) && Object.keys(p.baseSettings).length===7 && Object.entries(state.settings).every(([k,v])=>p.baseSettings[k]===v);
    const patchMatches=p && validPatch(p.settings) && Object.keys(p.settings).length===changes && Object.entries(result.changes).every(([k,v])=>p.settings[k]===v);
    if(!baseMatches || !patchMatches || !changes) return fail('need_clarification','之前的方案缺失，或参数/场景已变化，请重新提出方案。');
  }
  if(result.status==='ok' && ['set','apply_proposal'].includes(result.intent)) {
    const names={demand:'骑行车流',motorDemand:'机动车流',northDemand:'北侧来车',electric:'电动车占比',outbound:'地点1来车占比',northBypassShare:'北侧环岛绕行A',westSignalMode:'A配时'};
    const describe=Object.entries(result.changes).map(([k,v])=>names[k]+'设为'+(k==='westSignalMode'?(v==='adaptive'?'自动调控':'固定配时'):v+(['electric','outbound','northBypassShare'].includes(k)?'%':'辆/分钟'))).join('，');
    result.reply=changes?'已生成模拟沙盘调参指令：'+describe+'。参数尚未执行，生效结果需由沙盘核验。':'当前参数已符合要求，无需调整。';
  }
  return {output_json:JSON.stringify(result)};
}

// v2 is validated locally against a fresh owner snapshot; v1 remains only for archived cases.
function main({query,model_output}){
 let envelope;try{envelope=JSON.parse(query);}catch{return legacyMain({query,model_output});}
 if(envelope.protocol!=='campus-admin-v2')return legacyMain({query,model_output});
 const state=envelope.state,own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k),obj=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
 const fail=(status,reply)=>({repairable:status==='invalid_request',output_json:JSON.stringify({protocol:'campus-admin-v2',status,intent:'inspect',state_version:state?.stateVersion??null,reply,basis:'',changes:{},suggested_settings:{},evidence:[]})});
 const ranges={demand:[4,50],motorDemand:[0,20],northDemand:[0,20],electric:[0,100],outbound:[20,80],northBypassShare:[0,100],guidanceCoverage:[0,100]};
 const valid=p=>obj(p)&&Object.entries(p).every(([k,v])=>k==='westSignalMode'?['adaptive','fixed'].includes(v):own(ranges,k)&&typeof v==='number'&&Number.isFinite(v)&&v>=ranges[k][0]&&v<=ranges[k][1]);
 if(!obj(state)||state.source!=='synthetic-simulation'||typeof state.stateVersion!=='string'||typeof state.runId!=='string'||!Number.isSafeInteger(state.settingsRevision)||!obj(state.settings)||Object.keys(state.settings).length!==9||!['original','grouped'].includes(state.settings.behaviorMode)||!valid(Object.fromEntries(Object.entries(state.settings).filter(([k])=>k!=='behaviorMode')))||!obj(state.metrics))return fail('missing_data','当前状态缺失，参数未改变。');
 const resolve=path=>{if(!/^(settings|metrics|behavior|routes|clock)(\.[A-Za-z0-9_-]+)+$/.test(path))throw Error();let value=state;for(const key of path.split('.')){if(!obj(value)&&!Array.isArray(value)||!own(value,key))throw Error();value=value[key];}return value;};
 let result;try{const fenced=/^\s*```(?:json)?\s*(\{[\s\S]*\})\s*```\s*$/i.exec(model_output);result=JSON.parse(fenced?fenced[1]:model_output);}catch{return fail('invalid_request','AI返回格式未通过校验，参数未改变。');}
 const keys=['protocol','status','intent','state_version','reply','basis','changes','suggested_settings','evidence'];
 if(!obj(result)||Object.keys(result).length!==9||!keys.every(k=>own(result,k))||result.protocol!=='campus-admin-v2'||result.state_version!==state.stateVersion||!['ok','need_clarification','missing_data','invalid_request','out_of_scope'].includes(result.status)||!['inspect','set','suggest','apply_proposal'].includes(result.intent)||typeof result.reply!=='string'||!result.reply.trim()||result.reply.length>1000||typeof result.basis!=='string'||result.basis.length>350||!valid(result.changes)||!valid(result.suggested_settings)||!Array.isArray(result.evidence)||result.evidence.length>16)return fail('invalid_request','AI返回内容未通过校验，参数未改变。');
 // Bind this narrowly named setting only when the stated literal equals the owner value.
 // Counts, savings and other free-form numerals still require labeled backend facts.
 const bindCoverage=text=>text.replace(/(?:当前)?引导覆盖(?:设定)?(?:为|是)\s*(\d+(?:\.\d+)?)\s*%/g,(whole,value)=>{
  if(Number(value)!==state.settings.guidanceCoverage||typeof state.behavior?.facts?.strategy!=='string')return whole;
  if(!result.evidence.includes('behavior.facts.strategy'))result.evidence.push('behavior.facts.strategy');return '{{behavior.facts.strategy}}';
 });
 result.reply=bindCoverage(result.reply);result.basis=bindCoverage(result.basis);
 if(result.evidence.length>16)return fail('invalid_request','AI引用过多，请简短提问；参数未改变。');
 try{for(const path of result.evidence)resolve(path);}catch{return fail('invalid_request','AI引用了无法核对的状态，参数未改变。');}
 // Numerical assertions use owner-populated placeholders. Missing values stay explicitly missing.
 const render=text=>{
  const stripped=text.replace(/\{\{([^{}]+)\}\}/g,(_,path)=>{if(!result.evidence.includes(path))throw Error();const v=resolve(path);if(v!==null&&!['string','number','boolean'].includes(typeof v))throw Error();if(typeof v==='number'&&/^(behavior|metrics|routes)\./.test(path))throw Error();return '';}).replace(/地点[12](?:→|到|至)[12]/g,'地点之间').replace(/地点[12]/g,'地点');
  if(/[0-9]|\{\{|\}\}|[零〇一二两三四五六七八九十百千万]+(?:辆|人|秒|分钟|个百分点)|百分之[零〇一二两三四五六七八九十百千万]+/.test(stripped))throw Error();
  return text.replace(/\{\{([^{}]+)\}\}/g,(_,path)=>{const v=resolve(path);return v===null?'未统计':String(v);});
 };
 const related=/路线|绕行|分流|拥堵|优化|认知|意愿|引导|触达|建议|route|bypass|congest|guidance|awareness|willingness/i.test(envelope.question+' '+result.reply)||result.intent==='suggest';
 if(result.status==='ok'&&related){
  if(!obj(state.behavior)||typeof state.behavior.enabled!=='boolean')return fail('missing_data','路线行为数据缺失，无法解释分组影响；参数未改变。');
  if(state.behavior.enabled){
   if(!/路线认知/.test(result.basis)||!/尝试意愿/.test(result.basis)||!/引导触达/.test(result.basis)||!result.evidence.includes('behavior.facts.eligible')||!result.basis.includes('{{behavior.facts.eligible}}'))return fail('invalid_request','AI未提供可核对的认知、意愿与触达依据，请重新提问。');
  }else{
   if(!result.basis.includes('当前未启用认知与意愿分组，本次仍按原选路规则分析'))return fail('invalid_request','AI未正确说明当前选路模式，请重新提问。');
   if(/\{\{behavior\.facts\.(eligible|knowledge|willingness|notAware|notReached|unwilling|trialNotTaken)\}\}|(?:调整|提高|增加|修改|提升)[^。；,，]{0,8}引导覆盖|提高信息覆盖|可绕行学生中.*(?:已获引导|未获知)/.test(result.reply))return fail('invalid_request','当前分组未启用，请只按原选路规则和交通事实分析。');
  }
 }
 const nc=Object.keys(result.changes).length,ns=Object.keys(result.suggested_settings).length;
 if(result.status!=='ok'&&(nc||ns)||!['set','apply_proposal'].includes(result.intent)&&nc||result.intent!=='suggest'&&ns)return fail('invalid_request','AI操作类型与参数不一致，参数未改变。');
 if(result.status==='ok'&&result.intent==='apply_proposal'){
  const p=envelope.context?.pendingProposal;
  if(!p||p.runId!==state.runId||p.settingsRevision!==state.settingsRevision||!obj(p.baseSettings)||Object.keys(p.baseSettings).length!==9||!Object.entries(state.settings).every(([k,v])=>p.baseSettings[k]===v)||!valid(p.settings)||Object.keys(p.settings).length!==nc||!Object.entries(result.changes).every(([k,v])=>p.settings[k]===v)||!nc)return fail('need_clarification','之前的方案已失效或缺失，请重新提出方案。');
 }
 if(own(result.changes,'guidanceCoverage')&&!state.behavior?.enabled||own(result.suggested_settings,'guidanceCoverage')&&!state.behavior?.enabled)return fail('invalid_request','当前未启用认知与意愿分组，请先在场景设置切换选路规则。');
 try{result.reply=render(result.reply);result.basis=render(result.basis);}catch{return fail('invalid_request','AI数字或引用无法由当前状态核对，参数未改变。');}
 return {output_json:JSON.stringify(result)};
}
