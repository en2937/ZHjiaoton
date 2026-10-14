// Test-only cookie namespace. Different ports share localhost cookies.
import {AdminAuth} from '../auth.mjs';
export class IsolatedAdminAuth extends AdminAuth{
 name(transport){return transport==='secure'?'__Host-route_fixture_admin':'route_fixture_admin';}
 cookie(value,transport,clear=false){const original=super.cookie(value,transport,clear);return this.name(transport)+original.slice(original.indexOf('='));}
 authenticate(req,transport,options){
  const name=this.name(transport),base=super.cookie('',transport).split('=')[0];
  const values=(req.headers.cookie||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(name+'='));
  return super.authenticate({headers:{...req.headers,cookie:values.map(v=>base+v.slice(name.length)).join('; ')}},transport,options);
 }
}
