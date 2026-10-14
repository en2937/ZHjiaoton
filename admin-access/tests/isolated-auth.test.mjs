import test from 'node:test';
import assert from 'node:assert/strict';
import {IsolatedAdminAuth} from './isolated-auth.mjs';
test('browser fixtures never set or clear a production login cookie',()=>{
 const auth=new IsolatedAdminAuth();
 for(const t of ['local','secure'])for(const clear of [false,true]){const cookie=auth.cookie('test',t,clear);assert.match(cookie,/^(?:__Host-)?route_fixture_admin=/);assert.doesNotMatch(cookie,/traffic_admin/);}
});
test('browser fixtures ignore production cookies and accept only their own session',async()=>{
 const auth=new IsolatedAdminAuth();await auth.setup('browser_test','isolated-password-only');const {value}=await auth.login('browser_test','isolated-password-only','test','local');
 const req=cookie=>({headers:{cookie}});
 assert.equal(auth.authenticate(req('traffic_admin_local='+value),'local'),null);
 assert.ok(auth.authenticate(req('traffic_admin_local=unrelated; route_fixture_admin='+value),'local'));
 assert.equal(auth.authenticate(req('route_fixture_admin='+value+'; route_fixture_admin='+value),'local'),null);
});
