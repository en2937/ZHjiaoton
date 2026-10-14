const $=id=>document.getElementById(id);
let setup=false,busy=false;
function status(message){$('status').textContent=message;$('status').hidden=!message;}
$('toggle-password').onclick=()=>{const show=$('password').type==='password';$('password').type=show?'text':'password';$('toggle-password').textContent=show?'隐藏':'显示';$('toggle-password').setAttribute('aria-label',show?'隐藏密码':'显示密码');$('toggle-password').setAttribute('aria-pressed',String(show));};
try{const response=await fetch('/api/admin/status');if(!response.ok)throw new Error();const data=await response.json();setup=data.setupRequired&&data.canSetup;
 if(data.authenticated){location.replace('/');}else if(setup){document.title='设置管理员账号 · 校园交通';$('form-title').textContent='创建管理员账号';$('intro').textContent='完成设置后即可管理交通方案';$('password').autocomplete='new-password';$('password').minLength=12;$('password-help').hidden=false;$('password').setAttribute('aria-describedby','password-help');$('confirmation').hidden=false;$('confirm-password').required=true;$('submit').textContent='创建账号并登录';}
 else if(data.setupRequired){status('请先在服务器电脑设置管理员账号。');$('submit').disabled=true;}
}catch{status('登录服务暂不可用，请刷新重试。');$('submit').disabled=true;}
$('login-form').onsubmit=async event=>{event.preventDefault();if(busy)return;if(setup&&$('password').value!==$('confirm-password').value){status('两次输入的密码不一致。');$('confirm-password').focus();return;}busy=true;status('');$('submit').disabled=true;$('submit').textContent=setup?'正在创建…':'正在登录…';
 try{const response=await fetch(setup?'/api/admin/setup':'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('username').value.trim(),password:$('password').value})});const data=await response.json();if(!response.ok){status(data.message||'暂时无法登录，请稍后重试。');$('password').value='';$('password').focus();return;}location.replace('/');}
 catch{status('连接中断，请重试。');}
 finally{busy=false;$('submit').disabled=false;$('submit').textContent=setup?'创建账号并登录':'登录';}
};
