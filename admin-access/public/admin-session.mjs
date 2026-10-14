let session=null;
async function check(){try{const response=await fetch('/api/admin/session');if(response.status===401){location.replace('/login');return;}if(response.ok)session=await response.json();}catch{}}
await check();setInterval(check,30000);
document.getElementById('adminLogout').onclick=async()=>{try{const response=await fetch('/api/admin/logout',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session?.csrfToken||''},body:'{}'});if(response.ok||response.status===401)location.replace('/login');else document.getElementById('adminLogout').textContent='退出失败，请重试';}catch{document.getElementById('adminLogout').textContent='退出失败，请重试';}};
