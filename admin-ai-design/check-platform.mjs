import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const root=new URL('./',import.meta.url);
const code=await readFile(new URL('validate-response.js',root),'utf8');
const sandbox={};vm.createContext(sandbox);vm.runInContext(code,sandbox);
const cases=JSON.parse(await readFile(new URL('cases.json',root),'utf8'));
const results=JSON.parse(await readFile(new URL('platform-results.json',root),'utf8'));
const checks=results.map(item=>{
 const c=cases.find(c=>c.id===item.id);
 try {
  assert.ok(c);assert.ok(item.response,'尚无平台回答');
  // 两类合法拒绝都必须无changes；保留模型与首选分类的差异，避免隐藏这项记录。
  const compatibleRejection=c.id==='08-unsupported' && item.response.status==='out_of_scope' && c.expected.status==='invalid_request';
  assert.ok(item.response.status===c.expected.status || compatibleRejection,'请求处理状态不符');
  if(c.expected.intent)assert.equal(item.response.intent,c.expected.intent);
  assert.deepEqual(item.response.changes,c.expected.changes);
  const checked=JSON.parse(sandbox.main({query:JSON.stringify(c.query),model_output:JSON.stringify(item.response)}).output_json);
  assert.equal(checked.status,compatibleRejection?'out_of_scope':c.expected.status,'本地校验器拒绝了模型返回');
  assert.deepEqual(checked.changes,c.expected.changes);
  if(c.id==='03-suggest'){
   assert.ok(Object.keys(checked.suggested_settings).length>0);
   assert.ok(Object.keys(checked.suggested_settings).every(k=>['northBypassShare','westSignalMode'].includes(k)));
   assert.match(checked.reply,/B/);assert.match(checked.reply,/验证|观察|假设/);
  }
  if(c.id==='10-new-state'){assert.match(checked.reply,/90/);assert.equal(checked.state_version,c.query.state.stateVersion);}
  return {id:item.id,passed:true,status:checked.status,intent:checked.intent,...(compatibleRejection?{classificationNote:'首选分类invalid_request，模型返回out_of_scope；两者均拒绝执行，后端兼容处理。'}:{})};
 }catch(error){return {id:item.id,passed:false,error:error.message};}
});
const report={stage:'Dify Studio preview; not website integration',appUrl:'https://dify.zju.edu.cn/app/45cceeb9-149c-4d57-a2ec-0596bfd37029/workflow',source:'independent synthetic simulation samples',checkedAt:new Date().toISOString(),total:checks.length,passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,classificationVariations:checks.filter(c=>c.classificationNote).length,notRun:cases.filter(c=>!checks.some(r=>r.id===c.id)).map(c=>c.id),checks};
await writeFile(new URL('platform-checks.json',root),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;
