(function(){
"use strict";
var TK="cmcc_webui_token";
var state={profiles:[],drafts:{},logs:{},globalLog:[],busy:{},desktops:{},jobsById:{},jobsByProfile:{},tokenRequired:false,es:null,sseNeedTokenLogged:false,activeTab:"accounts",selectedDesktops:{},deskProtocol:{}};

function $(s,r){return(r||document).querySelector(s)}
function $$(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}
function toast(msg,err){var el=$("#toast");if(!el)return;el.textContent=msg;el.classList.toggle("error",!!err);el.classList.remove("hidden");clearTimeout(toast._t);toast._t=setTimeout(function(){el.classList.add("hidden")},2800);}
function getToken(){try{return localStorage.getItem(TK)||""}catch(_){return""}}
function setToken(v){try{if(v)localStorage.setItem(TK,v);else localStorage.removeItem(TK)}catch(_){}}
function humanError(err,fb){if(!err)return fb||"操作失败";if(typeof err==="string")return err;var c=err.code||err.error||"";var m=err.message||err.detail||"";var M={PROFILE_IN_USE:"账号已在保活中",VALIDATION:"填写有误",NOT_FOUND:"账号不存在",UNAUTHORIZED:"未授权",LOGIN_FAILED:"登录失败",AUTH_FAILED:"账号或密码错误",HTTP_401:"登录失败（401）",AUTH_REQUIRED:"需要先登录",NETWORK:"网络异常"};if(c&&M[c])return M[c];if(m&&typeof m==="string")return m;return fb||"操作失败";}
async function api(path,opts){opts=opts||{};var h=Object.assign({Accept:"application/json"},opts.headers||{});var t=getToken();if(t)h.Authorization="Bearer "+t;var b=opts.body;if(b!=null&&typeof b!=="string"){h["Content-Type"]="application/json";b=JSON.stringify(b)}var r;try{r=await fetch(path,{method:opts.method||"GET",headers:h,body:b})}catch(e){var e2=new Error("网络异常");e2.code="NETWORK";throw e2}var x=await r.text();var d=null;if(x){try{d=JSON.parse(x)}catch(_){d={raw:x}}}if(!r.ok){var e3=new Error(humanError(d||{},"请求失败("+r.status+")"));e3.status=r.status;e3.code=(d&&(d.code||d.error))||"";throw e3}return d}
function statusOf(p){var s=String((p&&(p.status||(p.job&&p.job.status)||p.jobStatus))||"idle").toLowerCase();if(s==="running"||s==="alive"||s==="starting")return"running";if(s==="error"||s==="failed")return"error";if(s==="stopped"||s==="stop"||s==="exited")return"stopped";return"idle"}
function statusLabel(st){return st==="running"?"运行中":st==="error"?"异常":st==="stopped"?"已停止":"空闲"}
function desktopStatusText(dx){if(!dx)return"未知";return dx.vmStatusShow||dx.statusName||(dx.vmStatus===1?"运行中":"已关机")}
function protocolLabel(v){var u=String(v||"").toUpperCase();if(!u)return"未选";if(u==="ZTE"||u==="ZX")return"ZTE";return"SCG"}
function modeIsOnce(v){var m=String(v||"live").toLowerCase();return m==="dry-run"||m==="dryrun"||m==="once"||m==="single"}
function modeLabel(v){return modeIsOnce(v)?"单轮":"永久"}
function modeApi(v){return modeIsOnce(v)?"once":"live"}
function durationForMode(m,ts){if(modeIsOnce(m)){var t=Number(ts||60);return t>0?t:60}return 0}
function jobOf(p){if(!p)return null;if(p.job&&typeof p.job==="object")return p.job;if(p.jobId&&state.jobsById[p.jobId])return state.jobsById[p.jobId];if(p.id&&state.jobsByProfile[p.id])return state.jobsByProfile[p.id];return null}

function ensureDraft(pid,p){
  var j=jobOf(p);var r=resolveUserProtocol(p&&p.protocol,p&&p.lastOfficialProtocol,j&&j.protocol);
  var m=(p&&p.mode)||(j&&j.mode)||"live";
  if(!state.drafts[pid]){
    state.drafts[pid]={displayName:(p&&p.displayName)||"",username:"",password:"",protocol:r,lastOfficialProtocol:r,clientProfile:(p&&p.clientProfile)||"linux",mode:m,intervalMin:5,trafficSec:60,durationSec:durationForMode(m,60),userServiceId:(p&&p.userServiceId)||"",desktopLabel:"",spuCode:(p&&(p.spuCode||p.spu_code))||""};
  }else if(p){var d=state.drafts[pid];
    if(!d.displayName&&p.displayName)d.displayName=p.displayName;
    if(!d.clientProfile&&p.clientProfile)d.clientProfile=p.clientProfile;
    if(p.protocol){d.protocol=p.protocol;d.lastOfficialProtocol=p.protocol}else if(j&&j.protocol){d.protocol=j.protocol;if(!d.lastOfficialProtocol)d.lastOfficialProtocol=j.protocol}
    if(!d.lastOfficialProtocol)d.lastOfficialProtocol=d.protocol||"ZTE";
    if(p.mode)d.mode=p.mode;else if(j&&j.mode)d.mode=j.mode;
  }
  return state.drafts[pid];
}
function resolveUserProtocol(){for(var i=0;i<arguments.length;i++){var v=arguments[i];if(v==null||v==="")continue;var u=String(v).toUpperCase();if(u==="ZX")u="ZTE";if(u==="SANGFOR")u="SCG";if(u==="ZTE"||u==="SCG")return u}return"ZTE"}
function pushGlobal(line,level){state.globalLog.push({at:new Date().toISOString(),line:String(line||""),level:level||"info"});if(state.globalLog.length>300)state.globalLog=state.globalLog.slice(-300);try{sessionStorage.setItem("cmcc_gLog",JSON.stringify(state.globalLog))}catch(_){}renderLogs()}
function pushCard(pid,line,at){if(!pid||!line)return;var a=state.logs[pid]||(state.logs[pid]=[]);a.push({at:at||new Date().toISOString(),line:String(line)});if(a.length>300)state.logs[pid]=a.slice(-300);try{sessionStorage.setItem("cmcc_l_"+pid,JSON.stringify(state.logs[pid]))}catch(_){}applyLogsToDom(pid)}
function shanghaiHms(iso){try{var d=iso instanceof Date?iso:new Date(iso||Date.now());if(isNaN(d.getTime()))return"";var p=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(d);var g=function(t){return(p.find(function(x){return x.type===t})||{}).value||""};return g("year")+"-"+g("month")+"-"+g("day")+" "+g("hour")+":"+g("minute")+":"+g("second")}catch(_){return""}}
function classifyLogLine(l){var s=String(l||"").toLowerCase();if(s.indexOf("error")>=0||s.indexOf("fail")>=0||s.indexOf("失败")>=0||s.indexOf("异常")>=0)return"error";if(s.indexOf("5xx")>=0||/\b5\d\d\b/.test(s))return"warn";return""}
function formatLogLine(x){var r=String(x&&x.line||"");if(!r)return"";if(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/.test(r))return r;var a=String(x&&x.at||"");var s="";if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(a)){try{var d=new Date(a);if(!isNaN(d.getTime()))s=d.toLocaleString("sv-SE",{timeZone:"Asia/Shanghai",hour12:false}).replace("T"," ").slice(0,19)}catch(_){}if(!s)s=a.slice(0,19).replace("T"," ")}else if(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(a))s=a.slice(0,19);return s?"["+s+"] "+r:r}
function profileLogsHtml(pid,L){var a=L||state.logs[pid]||[];var s=a.slice(-6);if(!s.length)return'<div style="padding:12px;text-align:center;color:#999;font-size:12px">暂无日志</div>';return s.map(function(x){var r=formatLogLine(x);var l=classifyLogLine(r);return'<div class="ll '+l+'" title="'+esc(r)+'"><span>'+esc(r)+'</span></div>'}).join("")}
function logsFingerprint(L){var a=L||[];if(!a.length)return"0";var x=a[a.length-1]||{};return String(a.length)+"|"+String(x.at||"")+"|"+String(x.line||"")}
function applyLogsToDom(pid){if(!pid)return;var p=state.logs[pid]||[];var f=logsFingerprint(p);var n=$('.sl[data-log="'+pid+'"]');if(n&&n.getAttribute("data-fp")!==f){n.innerHTML=profileLogsHtml(pid);n.setAttribute("data-fp",f);n.scrollTop=n.scrollHeight}}

// ---- Tab Switching ----
function switchTab(name){
  state.activeTab=name;
  $$(".tab-item").forEach(function(b){b.classList.toggle("active",b.getAttribute("data-tab")===name)});
  $$(".tab-panel").forEach(function(p){p.classList.toggle("active",p.id==="tab-"+name)});
  if(name==="accounts")renderAccounts();else if(name==="status")renderStatus();else if(name==="logs")renderLogs();
}

// ---- Stats ----
function renderStats(){
  var c={total:0,running:0,idle:0,error:0};
  for(var i=0;i<state.profiles.length;i++){var p=state.profiles[i];c.total++;var s=statusOf(p);if(s==="running")c.running++;else if(s==="error")c.error++;else c.idle++}
  forEachStat(function(el,k){var m={total:"账号 "+c.total,running:"运行 "+c.running,idle:"空闲 "+c.idle,error:"异常 "+c.error};if(m[k]!=null)el.textContent=m[k]});
}
function forEachStat(fn){$$("[data-k]").forEach(function(el){fn(el,el.getAttribute("data-k"))})}

// ---- Account Card ----
function renderAccounts(){
  var root=$("#account-grid");var e=$("#empty-accounts");
  if(!root)return;renderStats();
  var v=state.profiles.filter(function(p){return p&&!p.draft});
  if(!v.length){root.innerHTML='<div class="empty-state"><div class="empty-icon">📋</div><p>还没有账号</p><p style="color:#999;font-size:13px;margin-top:4px">点击下方按钮添加账号</p></div>';return}
  if(!state.selectedDesktops)state.selectedDesktops={};
  root.innerHTML=v.map(function(p){
    var pid=p.id,st=statusOf(p),d=ensureDraft(pid,p);
    var name=d.displayName||p.displayName||pid;
    var user=p.usernameMasked||"";
    var dl=state.desktops[pid]||[];
    var sel=state.selectedDesktops[pid]||[];
    if(!state.deskProtocol[pid])state.deskProtocol[pid]={};
    var initial=(name||"A").charAt(0).toUpperCase();
    var bodyHtml='';
    if(dl.length){
      bodyHtml='<div class="pc-list">'+dl.map(function(dx){
        var dxid=dx.userServiceId||dx.id||"";
        var checked=sel.indexOf(dxid)>=0;
        var proto=state.deskProtocol[pid][dxid]||"ZTE";
        var pwr=desktopStatusText(dx);
        var pwrCls=pwr==="运行中"||pwr==="开机运行中"?"pwr-on":"pwr-off";
        return'<div class="pc-row'+(checked?' checked':'')+'"><label class="pc-cb"><input type="checkbox" '+(checked?'checked':'')+' data-pid="'+esc(pid)+'" data-desk="'+esc(dxid)+'" data-label="'+esc(dx.desktopLabel||dx.name||dxid)+'" /></label>'+
          '<span class="pc-name">'+esc(dx.desktopLabel||dx.skuName||dx.name||dxid)+'</span>'+
          '<span class="pc-pwr '+pwrCls+'">'+esc(pwr)+'</span>'+
          '<div class="pc-proto"><span class="proto-btn'+(proto==="ZTE"?' on':'')+'" data-proto="'+esc(pid)+':'+esc(dxid)+':ZTE">ZTE</span><span class="proto-btn'+(proto==="SCG"?' on':'')+'" data-proto="'+esc(pid)+':'+esc(dxid)+':SCG">SCG</span><span class="proto-btn'+(proto==="V3"?' on':'')+'" data-proto="'+esc(pid)+':'+esc(dxid)+':V3">V3</span></div></div>'
      }).join("")+'</div>';
    }else{
      bodyHtml='<div class="pc-list" style="padding:20px;text-align:center;color:#999;font-size:13px">'+(user?'暂无云电脑，<button class="btn btn-sm btn-outline" onclick="refreshDesktops(\''+esc(pid)+'\')">刷新</button>':'请先添加账号')+'</div>';
    }
    return'<div class="acct-card" data-pid="'+esc(pid)+'"><div class="acct-head"><div class="acct-avatar" style="background:'+randColor(pid)+'">'+esc(initial)+'</div><div class="acct-info"><div class="acct-name">'+esc(name)+'</div><div class="acct-sub">'+esc(user||'未登录')+' · '+dl.length+'台</div></div><div style="display:flex;gap:4px">'+(dl.length?'<button class="btn btn-sm btn-outline" onclick="refreshDesktops(\''+esc(pid)+'\')" title="刷新电源状态">🔄</button>':'')+'<span class="badge badge-'+esc(st)+'">'+esc(statusLabel(st))+'</span><button class="btn btn-sm btn-outline" onclick="delAccount(\''+esc(pid)+'\')">✕</button></div></div>'+bodyHtml+
    '</div>'
  }).join("");
  $$('.pc-cb input[type="checkbox"]').forEach(function(cb){
    cb.addEventListener("change",function(){
      var pid=cb.getAttribute("data-pid");var did=cb.getAttribute("data-desk");var lb=cb.getAttribute("data-label");
      if(!state.selectedDesktops[pid])state.selectedDesktops[pid]=[];
      var arr=state.selectedDesktops[pid];
      if(cb.checked){if(arr.indexOf(did)<0)arr.push(did)}else{var idx=arr.indexOf(did);if(idx>=0)arr.splice(idx,1)}
      renderAccounts();
    })
  });
  $$('[data-proto]').forEach(function(el){
    el.addEventListener("click",function(ev){ev.stopPropagation();
      var parts=el.getAttribute("data-proto").split(":");var pid=parts[0],did=parts[1],val=parts[2];
      if(!state.deskProtocol[pid])state.deskProtocol[pid]={};state.deskProtocol[pid][did]=val;
      el.parentElement.querySelectorAll(".proto-btn").forEach(function(b){b.classList.toggle("on",b===el)});
    })
  });
}
function randColor(s){var h=0;for(var i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))%360;return"hsl("+h+",55%,55%)"}

// ---- Status Tab ----
function renderStatus(){
  var root=$("#keepalive-grid");var e=$("#empty-keepalive");
  if(!root)return;
  var items=[];
  for(var i=0;i<state.profiles.length;i++){
    var p=state.profiles[i];var d=state.drafts[p.id];var sel=state.selectedDesktops[p.id]||[];
    for(var j=0;j<sel.length;j++){
      var did=sel[j];var st=statusOf(p);var proto=state.deskProtocol&&state.deskProtocol[p.id]&&state.deskProtocol[p.id][did]||"ZTE";
      items.push({pid:p.id,deskId:did,name:(d&&d.displayName)||p.displayName||p.id,status:st,proto:proto,deskName:did});
    }
  }
  if(!items.length){root.innerHTML='<div class="empty-state"><div class="empty-icon">📡</div><p>尚无选中的云电脑</p><p style="color:#999;font-size:13px;margin-top:4px">先在「账号管理」勾选需要保活的云电脑</p></div>';return}
  var totalRunning=items.filter(function(x){return x.status==="running"}).length;
  root.innerHTML='<div class="vstats">'+
    '<div class="vstat"><span class="vstat-lb">已选择云电脑</span><span class="vstat-num">'+items.length+'</span></div>'+
    '<div class="vstat"><span class="vstat-lb">等待保活</span><span class="vstat-num">'+(items.length-totalRunning)+'</span></div>'+
    '<div class="vstat"><span class="vstat-lb">保活中</span><span class="vstat-num">'+totalRunning+'</span></div></div>'+
    '<div class="status-list">'+items.map(function(x){
      var st=x.status;var proto=x.proto;
      return'<div class="status-item status-'+esc(st)+'" data-pid="'+esc(x.pid)+'" data-desk="'+esc(x.deskId)+'"><div class="status-head"><div class="status-info"><span class="status-dot"></span><span class="status-name">'+esc(x.name)+'</span><span class="status-desk">'+esc(x.deskName)+'</span><span class="status-proto">V'+(proto==="V3"?"3":proto)+'</span></div><div style="display:flex;align-items:center;gap:8px"><span class="badge badge-'+esc(st)+'">'+esc(statusLabel(st))+'</span>'+(st==="running"?'<button class="btn btn-sm btn-danger" onclick="stopOne(\''+esc(x.pid)+'\')">⏹ 停止</button>':'<button class="btn btn-sm btn-primary" onclick="startOne(\''+esc(x.pid)+'\')">▶ 启动</button>')+'</div></div></div>'
    }).join("")+'</div>';
}

// ---- Keepalive Actions ----
async function startKeepalive(pid){
  var sel=state.selectedDesktops[pid]||[];if(!sel.length){toast("请选择云电脑",true);return}
  state.busy[pid]=true;var d=ensureDraft(pid);var p=state.profiles.find(function(x){return x.id===pid});
  var mode=modeApi(d.mode);var ts=Number(d.trafficSec||60);
  // Only call login if we have credentials
  if(d.username&&d.password){
    try{await api("/api/profiles/"+encodeURIComponent(pid)+"/login",{method:"POST",body:{username:d.username,password:d.password}})}catch(e){}
  }
  var success=0,fail=0;
  for(var i=0;i<sel.length;i++){
    var did=sel[i];var proto=state.deskProtocol&&state.deskProtocol[pid]&&state.deskProtocol[pid][did]||"ZTE";
    try{
      await api("/api/profiles/"+encodeURIComponent(pid)+"/select-desktop",{method:"POST",body:{userServiceId:did,desktopLabel:did}});
      await api("/api/profiles/"+encodeURIComponent(pid)+"/jobs",{method:"POST",body:{protocol:proto,mode:mode,clientProfile:"linux",intervalSec:300,trafficSec:ts,durationSec:durationForMode(mode,ts)}});
      success++;
    }catch(e){fail++}
  }
  if(success)toast("已启动 "+success+" 台");else toast("启动失败",true);
  state.busy[pid]=false;await loadProfiles();await loadLogs(pid);renderStatus();
}
async function startOne(pid){state.selectedDesktops[pid]=state.selectedDesktops[pid]||[];if(!state.selectedDesktops[pid].length)state.selectedDesktops[pid]=[state.drafts[pid]&&state.drafts[pid].userServiceId||""];await startKeepalive(pid)}
async function stopOne(pid){await onStop(pid)}
async function onStop(pid){state.busy[pid]=true;try{await api("/api/profiles/"+encodeURIComponent(pid)+"/jobs/current",{method:"DELETE"});toast("已停止");await loadProfiles();await loadLogs(pid)}catch(e){toast(humanError(e,"停止失败"),true)}finally{state.busy[pid]=false;renderStatus()}}

// ---- Logs Tab ----
function renderLogs(){var box=$("#global-log");if(!box)return;var l=state.globalLog.slice(-300);if(!l.length){box.innerHTML='<div style="padding:20px;text-align:center;color:#999">暂无日志</div>';return}box.innerHTML=l.map(function(x){var t=shanghaiHms(x.at)||"";var l=classifyLogLine(x.line);return'<div class="log-line '+esc(l)+'"><time>'+esc(t)+'</time><span>'+esc(x.line)+'</span></div>'}).join("");box.scrollTop=box.scrollHeight}
function openLog(pid){ensureLogModal();var el=$("#log-modal");var n=(state.profiles.find(function(x){return x.id===pid})||{}).displayName||pid;var t=el.querySelector("#log-full-title");if(t)t.textContent="日志 · "+n;var b=el.querySelector("#log-full-body");var a=state.logs[pid]||[];b.innerHTML=a.length?a.map(function(x){var r=formatLogLine(x);var l=classifyLogLine(r);return'<div class="log-line '+l+'"><span>'+esc(r)+'</span></div>'}).join(""):'<div style="padding:20px;text-align:center;color:#999">暂无日志</div>';b.scrollTop=b.scrollHeight;el.style.display="flex"}

// ---- Login Modal ----
function openLoginModal(pid){var m=$("#login-modal"),b=$("#login-modal-body"),t=$("#login-modal-title");if(!m||!b)return;if(t)t.textContent=pid?"登录账号":"添加账号";if(pid)b.setAttribute("data-pid",pid);else b.removeAttribute("data-pid");var p=pid?state.profiles.find(function(x){return x.id===pid}):null;var d=pid?ensureDraft(pid,p):null;var u=(d&&d.username)||(p&&p.usernameMasked)||"";b.innerHTML='<div class="form-section"><div class="form-group"><label>显示名（可选）</label><input type="text" id="login-displayName" value="'+(pid?esc(d&&d.displayName||""):"")+'" placeholder="留空使用账号" /></div><div class="form-group"><label>账号</label><input type="text" id="login-username" value="'+esc(u)+'" placeholder="手机号/邮箱" /></div><div class="form-group"><label>密码</label><input type="password" id="login-password" value="" placeholder="'+((p&&p.hasPassword)?"已保存，不改请留空":"请输入密码")+'" /></div><div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-primary" style="flex:1;justify-content:center" onclick="doLogin(\''+(pid||"")+'\',\'main\')">主帐号登录</button><button class="btn btn-outline" style="flex:1;justify-content:center" onclick="doLogin(\''+(pid||"")+'\',\'sub\')">子帐号登录</button></div><div id="login-msg" class="form-msg"></div></div>';m.classList.remove("hidden")}
function closeLoginModal(){var m=$("#login-modal");if(m)m.classList.add("hidden")}
async function doLogin(pid,mode){var g=$("#login-msg");if(!g)return;var u=($("#login-username")&&$("#login-username").value.trim())||"";var pwd=($("#login-password")&&$("#login-password").value)||"";if(!u||!pwd){g.textContent="请填写账号和密码";g.className="form-msg err";return}g.textContent="登录中…";g.className="form-msg ok";try{var tp=pid;if(!tp){var dn=($("#login-displayName")&&$("#login-displayName").value.trim())||"";var cr=await api("/api/profiles",{method:"POST",body:{displayName:dn||u,username:u,password:pwd}});var pr=cr&&cr.profile;if(!pr||!pr.id)throw Error("创建失败");tp=pr.id;ensureDraft(tp,pr);state.drafts[tp].username=u;state.drafts[tp].password=pwd;await api("/api/profiles/"+encodeURIComponent(tp)+"/login",{method:"POST",body:{username:u,password:pwd}})}else{state.drafts[pid].username=u;state.drafts[pid].password=pwd;await api("/api/profiles/"+encodeURIComponent(pid)+"/login",{method:"POST",body:{username:u,password:pwd}})}}catch(e){var em=humanError(e,"登录失败");g.textContent=em;g.className="form-msg err";return}g.textContent="";closeLoginModal();var dl=await api("/api/profiles/"+encodeURIComponent(tp)+"/desktops");state.desktops[tp]=(dl&&(dl.desktops||dl.items||dl.list))||[];await loadProfiles();toast("登录成功");pushGlobal("["+u+"] 登录成功")}

// ---- Config Modal ----
function openConfigModal(pid){var m=$("#config-modal"),b=$("#config-modal-body"),t=$("#config-modal-title");if(!m||!b)return;var p=state.profiles.find(function(x){return x.id===pid});if(!p)return;var d=ensureDraft(pid,p);var n=d.displayName||p.displayName||pid;if(t)t.textContent="配置 · "+n;var j=jobOf(p);var r=resolveUserProtocol(d.protocol,p&&p.protocol,j&&j.protocol);var mo=d.mode||(p&&p.mode)||(j&&j.mode)||"live";var cl=d.clientProfile||p.clientProfile||"linux";b.setAttribute("data-pid",pid);b.innerHTML='<div class="form-section"><div class="form-group"><label>显示名</label><input type="text" id="cfg-dn" value="'+esc(d.displayName||"")+'" /></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="form-group"><label>间隔(分钟)</label><input type="number" id="cfg-int" value="'+esc(String(d.intervalMin||5))+'" min="1" /></div><div class="form-group"><label>流量(秒)</label><input type="number" id="cfg-tr" value="'+esc(String(d.trafficSec||60))+'" min="5" /></div></div><div style="display:flex;gap:8px;margin-top:8px"><span class="seg-label">协议：</span><div class="seg"><span class="seg-btn'+(r==="ZTE"?" on":"")+'" onclick="setCfgKey(\''+esc(pid)+'\',\'protocol\',\'ZTE\')">ZTE</span><span class="seg-btn'+(r==="SCG"?" on":"")+'" onclick="setCfgKey(\''+esc(pid)+'\',\'protocol\',\'SCG\')">SCG</span></div><span class="seg-label">客户端：</span><div class="seg"><span class="seg-btn'+(cl==="linux"?" on":"")+'" onclick="setCfgKey(\''+esc(pid)+'\',\'client\',\'linux\')">Linux</span><span class="seg-btn'+(cl==="windows"?" on":"")+'" onclick="setCfgKey(\''+esc(pid)+'\',\'client\',\'windows\')">Win</span><span class="seg-btn'+(cl==="mac"?" on":"")+'" onclick="setCfgKey(\''+esc(pid)+'\',\'client\',\'mac\')">Mac</span></div><span class="seg-label">模式：</span><div class="seg"><span class="seg-btn'+(!modeIsOnce(mo)?" on":"")+'" onclick="setCfgKey(\''+esc(pid)+'\',\'mode\',\'live\')">永久</span><span class="seg-btn'+(modeIsOnce(mo)?" on":"")+'" onclick="setCfgKey(\''+esc(pid)+'\',\'mode\',\'once\')">单轮</span></div></div><div class="form-foot"><div id="cfg-msg" class="form-msg"></div><button class="btn btn-primary" onclick="saveConfig(\''+esc(pid)+'\')">保存</button></div>';m.classList.remove("hidden")}
function closeConfigModal(){var m=$("#config-modal");if(m)m.classList.add("hidden")}
function setCfgKey(pid,key,val){var d=ensureDraft(pid);if(key==="protocol"){d.protocol=val;d.lastOfficialProtocol=val}else if(key==="client")d.clientProfile=val;else if(key==="mode")d.mode=val}
async function saveConfig(pid){var g=$("#cfg-msg");if(!g)return;var d=ensureDraft(pid);var dn=($("#cfg-dn")&&$("#cfg-dn").value.trim())||"";var it=Number($("#cfg-int")&&$("#cfg-int").value||5);var tr=Number($("#cfg-tr")&&$("#cfg-tr").value||60);if(dn)d.displayName=dn;d.intervalMin=it;d.trafficSec=tr;g.textContent="保存中…";g.className="form-msg ok";try{await api("/api/profiles/"+encodeURIComponent(pid),{method:"PUT",body:{displayName:d.displayName||undefined,clientProfile:d.clientProfile||"linux",protocol:d.protocol||"ZTE",mode:d.mode||"live",intervalMin:it,trafficSec:tr}});toast("已保存");closeConfigModal();await loadProfiles()}catch(e){g.textContent=humanError(e,"保存失败");g.className="form-msg err"}}

// ---- Log Full Modal ----
function ensureLogModal(){var el=$("#log-modal");if(!el){el=document.createElement("div");el.id="log-modal";el.className="modal-overlay hidden";el.innerHTML='<div class="modal" style="max-width:600px"><div class="modal-head"><h2 id="log-full-title">日志</h2><span class="modal-x" onclick="closeLogModal()">✕</span></div><div class="log-box" id="log-full-body" style="max-height:60vh;overflow-y:auto;font-size:12px;background:#1a1a2e;color:#0f0;padding:12px;border-radius:8px;font-family:monospace"></div></div>';document.body.appendChild(el);el.addEventListener("click",function(ev){if(ev.target===el)closeLogModal()})}return el}
function closeLogModal(){var el=$("#log-modal");if(el)el.classList.add("hidden")}

// ---- Confirm ----
function confirmModal(t,b,o){return new Promise(function(r){var m=$("#modal"),tt=$("#modal-title"),bb=$("#modal-body"),ok=$("#modal-ok"),cc=$("#modal-cancel");if(!m||!ok||!cc){r(window.confirm(b||t));return}tt.textContent=t||"确认";bb.textContent=b||"";ok.textContent=o||"确定";m.classList.remove("hidden");var f=function(v){m.classList.add("hidden");ok.onclick=null;cc.onclick=null;r(v)};ok.onclick=function(){f(true)};cc.onclick=function(){f(false)}})}
async function delAccount(pid){var p=state.profiles.find(function(x){return x.id===pid});var n=(p&&p.displayName)||pid;var ok=await confirmModal("删除账号","确定删除「"+n+"」？","删除");if(!ok)return;state.busy[pid]=true;try{await api("/api/profiles/"+encodeURIComponent(pid),{method:"DELETE"});delete state.drafts[pid];delete state.logs[pid];delete state.desktops[pid];try{sessionStorage.removeItem("cmcc_l_"+pid)}catch(_){};toast("已删除");await loadProfiles()}catch(e){toast(humanError(e,"删除失败"),true)}finally{state.busy[pid]=false;renderAccounts()}}
async function refreshDesktops(pid,quiet){try{var d=await api("/api/profiles/"+encodeURIComponent(pid)+"/desktops?refresh=1");state.desktops[pid]=(d&&(d.desktops||d.items||d.list))||[];if(!quiet)toast("已刷新");renderAccounts()}catch(e){if(!quiet)toast(humanError(e,"刷新失败"),true)}}

// ---- Data Loading ----
async function loadJobs(){try{var d=await api("/api/jobs");var j=(d&&d.jobs)||d||[];var l=Array.isArray(j)?j:[];state.jobsById={};state.jobsByProfile={};for(var i=0;i<l.length;i++){var x=l[i]||{};var jid=x.id||x.jobId;if(jid)state.jobsById[jid]=x;var pid=x.profileId||x.accountId;if(pid)state.jobsByProfile[pid]=x}}catch(_){}}
async function loadProfiles(){try{await loadJobs();var d=await api("/api/profiles");state.profiles=((d&&d.profiles)||[]).filter(function(p){return p&&!p.draft});for(var i=0;i<state.profiles.length;i++){(function(pid){var p=state.profiles[i];ensureDraft(pid,p);if(p.userServiceId){if(!state.selectedDesktops[pid])state.selectedDesktops[pid]=[];if(state.selectedDesktops[pid].indexOf(p.userServiceId)<0)state.selectedDesktops[pid].push(p.userServiceId)}if(!state.desktops[pid]||!state.desktops[pid].length){state.desktops[pid]=[];api("/api/profiles/"+encodeURIComponent(pid)+"/desktops").then(function(dl){state.desktops[pid]=(dl&&(dl.desktops||dl.items||dl.list))||[];renderAccounts()}).catch(function(){})}})(state.profiles[i].id)}for(var ri=0;ri<state.profiles.length;ri++){var _pid=state.profiles[ri].id;try{var _ls=sessionStorage.getItem("cmcc_l_"+_pid);if(_ls)state.logs[_pid]=JSON.parse(_ls)}catch(_){}}renderStats();if(state.activeTab==="accounts")renderAccounts();else if(state.activeTab==="status")renderStatus()}catch(e){toast(humanError(e,"加载失败"),true)}}
async function loadLogs(pid){if(!pid)return;try{var d=await api("/api/profiles/"+encodeURIComponent(pid)+"/logs");state.logs[pid]=(d&&d.lines)||[];try{sessionStorage.setItem("cmcc_l_"+pid,JSON.stringify(state.logs[pid]))}catch(_){};applyLogsToDom(pid)}catch(_){}}

// ---- SSE ----
function applyJobEvent(d){if(!d||typeof d!=="object")return;var jid=d.jobId||d.id||null;var pid=d.profileId||d.profile_id||null;if(!jid&&!pid){if(d.detail&&d.detail!=="global-sse")pushGlobal(String(d.detail),d.status==="error"?"error":"info");return}var p=(jid&&state.jobsById[jid])||(pid&&state.jobsByProfile[pid])||null;var m=Object.assign({},p||{},d);if(jid){m.id=m.id||jid;state.jobsById[jid]=m}if(pid){m.profileId=m.profileId||pid;state.jobsByProfile[pid]=m}var st=m.status||"";var dt=d.detail?String(d.detail):"";if(/保活|keepalive|SCG|第.*轮|round/i.test(dt)||/保活|keepalive|SCG|第.*轮|round/i.test(st)){if(dt&&pid)pushCard(pid,dt)}else if(st&&(!p||p.status!==st))pushGlobal("["+(pid||jid)+"] "+st+(dt?" - "+dt:""),st==="error"?"error":"info");else if(dt&&dt!=="snapshot")pushGlobal("["+(pid||jid)+"] "+dt,st==="error"?"error":"info");if(pid&&state.activeTab==="status"){var c=$('.status-item[data-pid="'+pid+'"]');if(c){var ns=statusOf(m);c.className=c.className.split(/\s+/).filter(function(x){return x.indexOf("status-")!==0}).concat(["status-item","status-"+ns]).join(" ");var b=c.querySelector(".badge");if(b)b.textContent=statusLabel(ns);var s=c.querySelector('[onclick*="startOne"]');var t=c.querySelector('[onclick*="stopOne"]');if(s&&t){s.style.display=ns==="running"?"none":"";t.style.display=ns!=="running"?"none":""}}}}
function applyJobLogEvent(d){if(!d||typeof d!=="object")return;var l=d.line||d.message||"";if(!l)return;var p=d.profileId||"";if(p){pushCard(p,l);pushGlobal("["+p+"] "+l,classifyLogLine(l)||"info")}}
function connectSSE(){if(typeof EventSource==="undefined")return;try{if(state.es){try{state.es.close()}catch(_){}state.es=null}var t=getToken();if(state.tokenRequired&&!t){if(!state.sseNeedTokenLogged){pushGlobal("需要令牌","error");state.sseNeedTokenLogged=true}return}state.sseNeedTokenLogged=false;var u="/api/events";if(t)u+=(u.indexOf("?")>=0?"&":"?")+"token="+encodeURIComponent(t);var es=new EventSource(u);state.es=es;es.addEventListener("job_status",function(ev){try{applyJobEvent(JSON.parse(ev.data))}catch(_){}});es.addEventListener("job_log",function(ev){try{applyJobLogEvent(JSON.parse(ev.data))}catch(_){}});es.addEventListener("job_log_cleared",function(ev){try{var d=JSON.parse(ev.data)||{};var pid=d.profileId||"";if(!pid)return;state.logs[pid]=[];applyLogsToDom(pid)}catch(_){}});es.onmessage=function(ev){try{var d=JSON.parse(ev.data);if(d&&d.line)applyJobLogEvent(d);else if(d&&(d.status||d.jobId))applyJobEvent(d);else if(d&&d.detail)pushGlobal(String(d.detail),d.level||"info")}catch(_){}};es.onerror=function(){}}catch(_){}}

// ---- Polling ----
function startPolling(){
  setInterval(async function(){try{await loadJobs();var d=await api("/api/profiles");var n=((d&&d.profiles)||[]).filter(function(p){return p&&!p.draft});var pm={};for(var i=0;i<state.profiles.length;i++)pm[state.profiles[i].id]=statusOf(state.profiles[i]);var nf=n.length!==state.profiles.length;if(!nf){var a=state.profiles.map(function(x){return x.id}).join("\0");var b=n.map(function(x){return x.id}).join("\0");if(a!==b)nf=true}if(!nf)for(var i=0;i<n.length;i++){if(pm[n[i].id]!==statusOf(n[i])){nf=true;break}}state.profiles=n;if(nf){renderStats();if(state.activeTab==="accounts")renderAccounts();else if(state.activeTab==="status")renderStatus()}else if(state.activeTab==="status"){n.forEach(function(p){var c=$('.status-item[data-pid="'+p.id+'"]');if(!c)return;var st=statusOf(p);c.className=c.className.split(/\s+/).filter(function(x){return x.indexOf("status-")!==0}).concat(["status-item","status-"+st]).join(" ");var b=c.querySelector(".badge");if(b)b.textContent=statusLabel(st);var s=c.querySelector('[onclick*="startOne"]');var t=c.querySelector('[onclick*="stopOne"]');if(s&&t){s.style.display=st==="running"?"none":"";t.style.display=st!=="running"?"none":""}})}}catch(_){}},4000);
  setInterval(async function(){try{var l=state.profiles||[];for(var i=0;i<l.length;i++)if(l[i]&&l[i].id)await loadLogs(l[i].id).catch(function(){})}catch(_){}},6000);
  setInterval(async function(){try{var l=state.profiles||[];for(var i=0;i<l.length;i++)if(l[i]&&l[i].id)await refreshDesktops(l[i].id,true).catch(function(){})}catch(_){}},30000);
}

// ---- Boot ----
async function loadSys(){try{var i=await api("/api/system/info");state.tokenRequired=!!(i&&i.tokenRequired);var e=$("#sys-info");if(e)e.textContent="v"+(i.version||"?")+(state.tokenRequired?" · 需令牌":"")}catch(e){if(e&&(e.status===401))state.tokenRequired=true;var e2=$("#sys-info");if(e2)e2.textContent=state.tokenRequired?"需令牌":""}var r=$("#token-row");if(r)r.style.display=state.tokenRequired?"flex":"none"}
function clearToken(){setToken("");state.sseNeedTokenLogged=false;if(state.es){try{state.es.close()}catch(_){}state.es=null}loadSys();toast("已清除")}

function boot(){
  $$(".tab-item").forEach(function(b){b.addEventListener("click",function(){switchTab(b.getAttribute("data-tab"))})});
  $("#login-modal-close")&&$("#login-modal-close").addEventListener("click",closeLoginModal);
  $("#config-modal-close")&&$("#config-modal-close").addEventListener("click",closeConfigModal);
  $("#btn-add-account")&&$("#btn-add-account").addEventListener("click",function(){openLoginModal("")});
  $("#btn-refresh")&&$("#btn-refresh").addEventListener("click",async function(){var b=$("#btn-refresh");if(b)b.disabled=true;try{await loadJobs();await loadProfiles();var ids=state.profiles.map(function(p){return p.id});await Promise.all(ids.map(function(pid){return loadLogs(pid).catch(function(){})}));toast("已刷新")}catch(e){toast("刷新失败",true)}finally{if(b)b.disabled=false}});
  $("#btn-clear-log")&&$("#btn-clear-log").addEventListener("click",function(){state.globalLog=[];renderLogs()});
  $("#btn-help")&&$("#btn-help").addEventListener("click",function(){$("#help-modal").classList.remove("hidden")});
  $("#help-close")&&$("#help-close").addEventListener("click",function(){$("#help-modal").classList.add("hidden")});
  $("#btn-token")&&$("#btn-token").addEventListener("click",function(){var t=($("#token-input")&&$("#token-input").value)||"";if(!t){toast("请输入令牌",true);return}setToken(t);connectSSE();toast("已设置")});
  $("#btn-clear-token")&&$("#btn-clear-token").addEventListener("click",clearToken);
  document.addEventListener("keydown",function(ev){if(ev.key==="Escape"){if($("#log-modal")&&$("#log-modal").style.display!=="none")closeLogModal();else if($("#login-modal")&&!$("#login-modal").classList.contains("hidden"))closeLoginModal();else if($("#config-modal")&&!$("#config-modal").classList.contains("hidden"))closeConfigModal();else if($("#help-modal")&&!$("#help-modal").classList.contains("hidden"))$("#help-modal").classList.add("hidden")}});
  try{var u=new URL(location.href);var t=u.searchParams.get("token");if(t){setToken(t);u.searchParams.delete("token");history.replaceState({},"",u.pathname+u.search+u.hash);connectSSE()}}catch(_){}
  try{var _g=sessionStorage.getItem("cmcc_gLog");if(_g)state.globalLog=JSON.parse(_g);renderLogs()}catch(_){}
  pushGlobal("云电脑保活管理 · 就绪");
  loadSys();loadProfiles();connectSSE();switchTab("accounts");startPolling();
}
// Expose functions for onclick attributes in HTML templates
window.startKeepalive=startKeepalive;window.delAccount=delAccount;window.refreshDesktops=refreshDesktops;
window.startOne=startOne;window.stopOne=stopOne;window.openLog=openLog;
window.closeLogModal=closeLogModal;
window.doLogin=doLogin;window.setCfgKey=setCfgKey;window.saveConfig=saveConfig;
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
})();
