(function(){
"use strict";
var TK="cmcc_webui_token";
var state={profiles:[],drafts:{},logs:{},globalLog:[],busy:{},desktops:{},tokenRequired:false,activeTab:"accounts",selectedDesktops:{},deskProtocol:{}};

function $(s,r){return(r||document).querySelector(s)}
function $$(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}
function toast(msg,err){var el=$("#toast");if(!el)return;el.textContent=msg;el.classList.toggle("error",!!err);el.classList.remove("hidden");clearTimeout(toast._t);toast._t=setTimeout(function(){el.classList.add("hidden")},2800);}
function getToken(){try{return localStorage.getItem(TK)||""}catch(_){return""}}
function setToken(v){try{if(v)localStorage.setItem(TK,v);else localStorage.removeItem(TK)}catch(_){}}
function humanError(err,fb){if(!err)return fb||"操作失败";if(typeof err==="string")return err;var c=err.code||err.error||"";var m=err.message||err.detail||"";var M={JOB_IN_USE:"桌面已在保活中",VALIDATION:"填写有误",NOT_FOUND:"账号不存在",UNAUTHORIZED:"未授权",LOGIN_FAILED:"登录失败",AUTH_FAILED:"账号或密码错误",HTTP_401:"登录失败（401）",AUTH_REQUIRED:"需要先登录",NETWORK:"网络异常"};if(c&&M[c])return M[c];if(m&&typeof m==="string")return m;return fb||"操作失败";}
async function api(path,opts){opts=opts||{};var h=Object.assign({Accept:"application/json"},opts.headers||{});var t=getToken();if(t)h.Authorization="Bearer "+t;var b=opts.body;if(b!=null&&typeof b!=="string"){h["Content-Type"]="application/json";b=JSON.stringify(b)}var r;try{r=await fetch(path,{method:opts.method||"GET",headers:h,body:b})}catch(e){var e2=new Error("网络异常");e2.code="NETWORK";throw e2}var x=await r.text();var d=null;if(x){try{d=JSON.parse(x)}catch(_){d={raw:x}}}if(!r.ok){var e3=new Error(humanError(d||{},"请求失败("+r.status+")"));e3.status=r.status;e3.code=(d&&(d.code||d.error))||"";throw e3}return d}
function statusLabel(st){return st==="running"?"运行中":st==="error"?"异常":st==="stopped"?"已停止":"空闲"}
function desktopStatusText(dx){if(!dx)return"未知";return dx.vmStatusShow||dx.statusName||(dx.vmStatus===1?"运行中":"已关机")}
function protocolLabel(v){var u=String(v||"").toUpperCase();if(!u)return"未选";if(u==="ZTE"||u==="ZX")return"ZTE";if(u==="CAG")return"CAG";if(u==="V3")return"V3";return u}
function modeIsOnce(v){var m=String(v||"live").toLowerCase();return m==="dry-run"||m==="dryrun"||m==="once"||m==="single"}
function modeLabel(v){return modeIsOnce(v)?"单轮":"永久"}
function modeApi(v){return modeIsOnce(v)?"once":"live"}
function durationForMode(m,ts){if(modeIsOnce(m)){var t=Number(ts||60);return t>0?t:60}return 0}

function ensureDraft(pid,p){
  var j=p&&p.desktopStatuses&&p.desktopStatuses[0]||null;
  var r=resolveUserProtocol(p&&p.protocol,p&&p.lastOfficialProtocol,j&&j.protocol);
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
function resolveUserProtocol(){for(var i=0;i<arguments.length;i++){var v=arguments[i];if(v==null||v==="")continue;var u=String(v).toUpperCase();if(u==="ZX")u="ZTE";if(u==="SANGFOR"||u==="SCG")u="CAG";if(u==="ZTE"||u==="CAG"||u==="V3")return u}return"ZTE"}
function pushGlobal(line,level){state.globalLog.push({at:new Date().toISOString(),line:String(line||""),level:level||"info"});if(state.globalLog.length>500)state.globalLog=state.globalLog.slice(-500);try{sessionStorage.setItem("cmcc_gLog",JSON.stringify(state.globalLog))}catch(_){}renderLogs()}
function pushCard(pid,did,line,at){if(!pid||!line)return;if(!state.logs[pid])state.logs[pid]={};if(!state.logs[pid][did])state.logs[pid][did]=[];var a=state.logs[pid][did];a.push({at:at||new Date().toISOString(),line:String(line)});if(a.length>500)state.logs[pid][did]=a.slice(-500);applyLogsToDom(pid,did)}
function shanghaiHms(iso){try{var d=iso instanceof Date?iso:new Date(iso||Date.now());if(isNaN(d.getTime()))return"";var p=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(d);var g=function(t){return(p.find(function(x){return x.type===t})||{}).value||""};return g("year")+"-"+g("month")+"-"+g("day")+" "+g("hour")+":"+g("minute")+":"+g("second")}catch(_){return""}}
function classifyLogLine(l){var s=String(l||"").toLowerCase();if(s.indexOf("error")>=0||s.indexOf("fail")>=0||s.indexOf("失败")>=0||s.indexOf("异常")>=0)return"error";if(s.indexOf("5xx")>=0||/\b5\d\d\b/.test(s))return"warn";return""}
function formatLogLine(x){var r=String(x&&x.line||"");if(!r)return"";if(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/.test(r))return r;var a=String(x&&x.at||"");var s="";if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(a)){try{var d=new Date(a);if(!isNaN(d.getTime()))s=d.toLocaleString("sv-SE",{timeZone:"Asia/Shanghai",hour12:false}).replace("T"," ").slice(0,19)}catch(_){}if(!s)s=a.slice(0,19).replace("T"," ")}else if(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(a))s=a.slice(0,19);return s?"["+s+"] "+r:r}
function perDesktopStatus(pid,did){var ds=state.deskStatuses&&state.deskStatuses[pid]&&state.deskStatuses[pid][did];return ds?ds.status||"idle":"idle"}
function logsFingerprint(pid,did){var a=(state.logs[pid]&&state.logs[pid][did])||[];if(!a.length)return"0";var x=a[a.length-1]||{};return String(a.length)+"|"+String(x.at||"")+"|"+String(x.line||"")}
function applyLogsToDom(pid,did){if(!pid||!did)return;var a=(state.logs[pid]&&state.logs[pid][did])||[];var f=logsFingerprint(pid,did);var n=$('.sl[data-log="'+pid+'"][data-desk="'+did+'"]');if(n&&n.getAttribute("data-fp")!==f){n.innerHTML=profileLogsHtml(pid,did);n.setAttribute("data-fp",f);n.scrollTop=n.scrollHeight}}
function profileLogsHtml(pid,did){var a=(state.logs[pid]&&state.logs[pid][did])||[];var s=a.slice(-6);if(!s.length)return'<div style="padding:12px;text-align:center;color:#999;font-size:12px">暂无日志</div>';return s.map(function(x){var r=formatLogLine(x);var l=classifyLogLine(r);return'<div class="ll '+l+'" title="'+esc(r)+'"><span>'+esc(r)+'</span></div>'}).join("")}

function switchTab(name){
  state.activeTab=name;
  $$(".tab-item").forEach(function(b){b.classList.toggle("active",b.getAttribute("data-tab")===name)});
  $$(".tab-panel").forEach(function(p){p.classList.toggle("active",p.id==="tab-"+name)});
  if(name==="accounts")renderAccounts();else if(name==="status")renderStatus();else if(name==="logs")renderLogs();
}

function renderStats(){
  var c={total:0,running:0,idle:0,error:0};
  for(var i=0;i<state.profiles.length;i++){var p=state.profiles[i];c.total++;var any=false;if(state.deskStatuses&&state.deskStatuses[p.id]){for(var k in state.deskStatuses[p.id]){var s=state.deskStatuses[p.id][k].status;if(s==="running"){c.running++;any=true;break}else if(s==="error"){c.error++;any=true;break}}}if(!any)c.idle++}
  forEachStat(function(el,k){var m={total:"账号 "+c.total,running:"运行 "+c.running,idle:"空闲 "+c.idle,error:"异常 "+c.error};if(m[k]!=null)el.textContent=m[k]});
}
function forEachStat(fn){$$("[data-k]").forEach(function(el){fn(el,el.getAttribute("data-k"))})}

function renderAccounts(){
  var root=$("#account-grid");
  if(!root)return;renderStats();
  var v=state.profiles.filter(function(p){return p&&!p.draft});
  if(!v.length){root.innerHTML='<div class="empty-state"><div class="empty-icon">📋</div><p>还没有账号</p><p style="color:#999;font-size:13px;margin-top:4px">点击下方按钮添加账号</p></div>';return}
  if(!state.selectedDesktops)state.selectedDesktops={};
  root.innerHTML=v.map(function(p){
    var pid=p.id,d=ensureDraft(pid,p);
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
          '<div class="pc-proto"><span class="proto-btn'+(proto==="ZTE"?' on':'')+'" data-proto="'+esc(pid)+':'+esc(dxid)+':ZTE">ZTE</span><span class="proto-btn'+(proto==="CAG"?' on':'')+'" data-proto="'+esc(pid)+':'+esc(dxid)+':CAG">CAG</span><span class="proto-btn'+(proto==="V3"?' on':'')+'" data-proto="'+esc(pid)+':'+esc(dxid)+':V3">V3</span></div></div>'
      }).join("")+'</div>';
    }else{
      bodyHtml='<div class="pc-list" style="padding:20px;text-align:center;color:#999;font-size:13px">'+(user?'暂无云电脑，<button class="btn btn-sm btn-outline" onclick="refreshDesktops(\''+esc(pid)+'\')">刷新</button>':'请先添加账号')+'</div>';
    }
    return'<div class="acct-card" data-pid="'+esc(pid)+'"><div class="acct-head"><div class="acct-avatar" style="background:'+randColor(pid)+'">'+esc(initial)+'</div><div class="acct-info"><div class="acct-name">'+esc(name)+'</div><div class="acct-sub">'+esc(user||'未登录')+' · '+dl.length+'台</div></div><div style="display:flex;gap:4px">'+(dl.length?'<button class="btn btn-sm btn-outline" onclick="refreshDesktops(\''+esc(pid)+'\')" title="刷新电源状态">🔄</button>':'')+'<span class="badge badge-'+esc(p.jobStatus||"idle")+'">'+esc(statusLabel(p.jobStatus||"idle"))+'</span><button class="btn btn-sm btn-outline" onclick="delAccount(\''+esc(pid)+'\')">✕</button></div></div>'+bodyHtml+
    '<div class="acct-actions" style="padding:8px 12px;border-top:1px solid var(--border,#eee)">'+
    '<button class="btn btn-primary btn-sm" style="width:100%;justify-content:center" onclick="startKeepalive(\''+esc(pid)+'\')"'+(state.busy[pid]?' disabled':'')+'>🚀 启动保活</button></div>'+
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
      persistDeskProtocol(pid,did,val);
    })
  });
}
function randColor(s){var h=0;for(var i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))%360;return"hsl("+h+",55%,55%)"}

async function persistDeskProtocol(pid,did,proto){
  var d=state.drafts[pid];if(d){d.lastOfficialProtocol=proto;d.protocol=proto}
  try{
    await api("/api/profiles/"+encodeURIComponent(pid),{method:"PUT",body:{desktopProtocol:{[did]:proto},protocol:proto,mode:d&&d.mode}});
  }catch(e){}
}

function renderStatus(){
  var root=$("#keepalive-grid");
  if(!root)return;
  var items=[];
  var pid,sel,did,st,proto;
  for(var i=0;i<state.profiles.length;i++){
    pid=state.profiles[i].id;sel=state.selectedDesktops[pid]||[];
    for(var j=0;j<sel.length;j++){
      did=sel[j];
      st=perDesktopStatus(pid,did);
      proto=state.deskProtocol&&state.deskProtocol[pid]&&state.deskProtocol[pid][did]||"ZTE";
      items.push({pid:pid,deskId:did,name:(state.drafts[pid]&&state.drafts[pid].displayName)||state.profiles[i].displayName||pid,status:st,proto:proto});
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
      return'<div class="status-item status-'+esc(st)+'" data-pid="'+esc(x.pid)+'" data-desk="'+esc(x.deskId)+'"><div class="status-head"><div class="status-info"><span class="status-dot"></span><span class="status-name">'+esc(x.name)+'</span><span class="status-desk">'+esc(x.deskId)+'</span><span class="status-proto">'+esc(proto)+'</span></div><div style="display:flex;align-items:center;gap:8px"><span class="badge badge-'+esc(st)+'">'+esc(statusLabel(st))+'</span>'+(st==="running"?'<button class="btn btn-sm btn-danger" onclick="stopOne(\''+esc(x.pid)+'\',\''+esc(x.deskId)+'\')">⏹ 停止</button>':'<button class="btn btn-sm btn-primary" onclick="startOne(\''+esc(x.pid)+'\',\''+esc(x.deskId)+'\')">▶ 启动</button>')+'</div></div>'+
      '<div class="sl-wrap"><div class="sl" data-log="'+esc(x.pid)+'" data-desk="'+esc(x.deskId)+'" data-fp="0">'+profileLogsHtml(x.pid,x.deskId)+'</div>'+
      '<div class="sl-actions"><button class="btn btn-xs btn-outline" onclick="loadDesktopLogs(\''+esc(x.pid)+'\',\''+esc(x.deskId)+'\')">🔄 刷新日志</button></div></div></div>'
    }).join("")+'</div>';
}

async function startKeepalive(pid){
  var sel=state.selectedDesktops[pid]||[];if(!sel.length){toast("请选择云电脑",true);return}
  state.busy[pid]=true;var d=ensureDraft(pid);
  var mode=modeApi(d.mode);var ts=Number(d.trafficSec||60);
  if(d.username&&d.password){
    try{await api("/api/profiles/"+encodeURIComponent(pid)+"/login",{method:"POST",body:{username:d.username,password:d.password}})}catch(e){}
  }
  var started=0;
  for(var i=0;i<sel.length;i++){
    var did=sel[i];
    var dp=state.deskProtocol&&state.deskProtocol[pid]&&state.deskProtocol[pid][did];
    var proto=dp||(d&&d.protocol)||"ZTE";
    try{
      await api("/api/profiles/"+encodeURIComponent(pid)+"/select-desktop",{method:"POST",body:{userServiceId:did,desktopLabel:did,lastOfficialProtocol:proto}});
    }catch(e){}
    try{
      await api("/api/profiles/"+encodeURIComponent(pid)+"/desktops/"+encodeURIComponent(did)+"/jobs",{method:"POST",body:{protocol:proto,mode:mode,intervalSec:300,trafficSec:ts,durationSec:durationForMode(mode,ts)}});
      started++;
    }catch(e){toast(humanError(e,did+"启动失败"),true)}
  }
  if(started)toast("已启动 "+started+" 台");
  state.busy[pid]=false;await loadProfiles();await loadAllDesktopLogs(pid);
}
async function startOne(pid,did){
  state.selectedDesktops[pid]=state.selectedDesktops[pid]||[];
  if(state.selectedDesktops[pid].indexOf(did)<0)state.selectedDesktops[pid].push(did);
  var d=state.drafts[pid];
  if(d&&d.protocol&&!state.deskProtocol[pid])state.deskProtocol[pid]={};
  if(d&&d.protocol&&!state.deskProtocol[pid][did])state.deskProtocol[pid][did]=d.protocol;
  state.busy[pid]=true;
  var mode=modeApi(d&&d.mode||"live");var ts=Number(d&&d.trafficSec||60);
  var proto=state.deskProtocol[pid][did]||(d&&d.protocol)||"ZTE";
  try{
    await api("/api/profiles/"+encodeURIComponent(pid)+"/desktops/"+encodeURIComponent(did)+"/jobs",{method:"POST",body:{protocol:proto,mode:mode,intervalSec:300,trafficSec:ts,durationSec:durationForMode(mode,ts)}});
    toast("已启动");
    await loadProfiles();await loadDesktopLogs(pid,did);
  }catch(e){toast(humanError(e,"启动失败"),true)}
  state.busy[pid]=false;renderStatus();
}
async function stopOne(pid,did){
  state.busy[pid]=true;
  try{
    await api("/api/profiles/"+encodeURIComponent(pid)+"/desktops/"+encodeURIComponent(did)+"/jobs/current",{method:"DELETE"});
    toast("已停止");
    await loadProfiles();await loadDesktopLogs(pid,did);
  }catch(e){toast(humanError(e,"停止失败"),true)}
  state.busy[pid]=false;renderStatus();
}

function renderLogs(){var box=$("#global-log");if(!box)return;var l=state.globalLog.slice(-500);if(!l.length){box.innerHTML='<div style="padding:20px;text-align:center;color:#999">暂无日志</div>';return}box.innerHTML=l.map(function(x){var t=shanghaiHms(x.at)||"";var l=classifyLogLine(x.line);return'<div class="log-line '+esc(l)+'"><time>'+esc(t)+'</time><span>'+esc(x.line)+'</span></div>'}).join("");box.scrollTop=box.scrollHeight}

function openLoginModal(pid){var m=$("#login-modal"),b=$("#login-modal-body"),t=$("#login-modal-title");if(!m||!b)return;if(t)t.textContent=pid?"登录账号":"添加账号";if(pid)b.setAttribute("data-pid",pid);else b.removeAttribute("data-pid");var p=pid?state.profiles.find(function(x){return x.id===pid}):null;var d=pid?ensureDraft(pid,p):null;var u=(d&&d.username)||(p&&p.usernameMasked)||"";b.innerHTML='<div class="form-section"><div class="form-group"><label>显示名（可选）</label><input type="text" id="login-displayName" value="'+(pid?esc(d&&d.displayName||""):"")+'" placeholder="留空使用账号" /></div><div class="form-group"><label>账号</label><input type="text" id="login-username" value="'+esc(u)+'" placeholder="手机号/邮箱" /></div><div class="form-group"><label>密码</label><input type="password" id="login-password" value="" placeholder="'+((p&&p.hasPassword)?"已保存，不改请留空":"请输入密码")+'" /></div><div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-primary" style="flex:1;justify-content:center" onclick="doLogin(\''+(pid||"")+'\',\'main\')">主帐号登录</button><button class="btn btn-outline" style="flex:1;justify-content:center" onclick="doLogin(\''+(pid||"")+'\',\'sub\')">子帐号登录</button></div><div id="login-msg" class="form-msg"></div></div>';m.classList.remove("hidden")}
function closeLoginModal(){var m=$("#login-modal");if(m)m.classList.add("hidden")}
async function doLogin(pid,mode){var g=$("#login-msg");if(!g)return;var u=($("#login-username")&&$("#login-username").value.trim())||"";var pwd=($("#login-password")&&$("#login-password").value)||"";if(!u||!pwd){g.textContent="请填写账号和密码";g.className="form-msg err";return}g.textContent="登录中…";g.className="form-msg ok";try{var tp=pid;if(!tp){var dn=($("#login-displayName")&&$("#login-displayName").value.trim())||"";var cr=await api("/api/profiles",{method:"POST",body:{displayName:dn||u,username:u,password:pwd}});var pr=cr&&cr.profile;if(!pr||!pr.id)throw Error("创建失败");tp=pr.id;ensureDraft(tp,pr);state.drafts[tp].username=u;state.drafts[tp].password=pwd;await api("/api/profiles/"+encodeURIComponent(tp)+"/login",{method:"POST",body:{username:u,password:pwd}})}else{state.drafts[pid].username=u;state.drafts[pid].password=pwd;await api("/api/profiles/"+encodeURIComponent(pid)+"/login",{method:"POST",body:{username:u,password:pwd}})}}catch(e){var em=humanError(e,"登录失败");g.textContent=em;g.className="form-msg err";return}g.textContent="";closeLoginModal();var dl=await api("/api/profiles/"+encodeURIComponent(tp)+"/desktops");state.desktops[tp]=(dl&&(dl.desktops||dl.items||dl.list))||[];await loadProfiles();toast("登录成功");pushGlobal("["+u+"] 登录成功")}

function openConfigModal(pid){var m=$("#config-modal"),b=$("#config-modal-body"),t=$("#config-modal-title");if(!m||!b)return;var p=state.profiles.find(function(x){return x.id===pid});if(!p)return;var d=ensureDraft(pid,p);var n=d.displayName||p.displayName||pid;if(t)t.textContent="配置 · "+n;var j=p.desktopStatuses&&p.desktopStatuses[0]||null;var r=resolveUserProtocol(d.protocol,p&&p.protocol,j&&j.protocol);var mo=d.mode||(p&&p.mode)||(j&&j.mode)||"live";var cl=d.clientProfile||p.clientProfile||"linux";b.setAttribute("data-pid",pid);b.innerHTML='<div class="form-section"><div class="form-group"><label>显示名</label><input type="text" id="cfg-dn" value="'+esc(d.displayName||"")+'" /></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="form-group"><label>间隔(分钟)</label><input type="number" id="cfg-int" value="'+esc(String(d.intervalMin||5))+'" min="1" /></div><div class="form-group"><label>流量(秒)</label><input type="number" id="cfg-tr" value="'+esc(String(d.trafficSec||60))+'" min="5" /></div></div><div style="display:flex;gap:8px;margin-top:8px"><span class="seg-label">协议：</span><div class="seg"><span class="seg-btn'+(r==="ZTE"?" on":"")+'" onclick="setCfgKey(\''+esc(pid)+'\',\'protocol\',\'ZTE\')">ZTE</span><span class="seg-btn'+(r==="CAG"?" on":"")+'" onclick="setCfgKey(\''+esc(pid)+'\',\'protocol\',\'CAG\')">CAG</span><span class="seg-btn'+(r==="V3"?" on":"")+'" onclick="setCfgKey(\''+esc(pid)+'\',\'protocol\',\'V3\')">V3</span></div><span class="seg-label">客户端：</span><div class="seg"><span class="seg-btn'+(cl==="linux"?" on":"")+'" onclick="setCfgKey(\''+esc(pid)+'\',\'client\',\'linux\')">Linux</span><span class="seg-btn'+(cl==="windows"?" on":"")+'" onclick="setCfgKey(\''+esc(pid)+'\',\'client\',\'windows\')">Win</span><span class="seg-btn'+(cl==="mac"?" on":"")+'" onclick="setCfgKey(\''+esc(pid)+'\',\'client\',\'mac\')">Mac</span></div></div><div id="cfg-msg" class="form-msg"></div><div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-primary" style="flex:1;justify-content:center" onclick="saveConfig(\''+esc(pid)+'\')">保存</button><button class="btn btn-outline" onclick="closeConfigModal()">取消</button></div></div>';m.classList.remove("hidden")}
function closeConfigModal(){var m=$("#config-modal");if(m)m.classList.add("hidden")}
function setCfgKey(pid,key,val){var d=ensureDraft(pid);if(key==="protocol"){d.protocol=val;d.lastOfficialProtocol=val}else if(key==="client")d.clientProfile=val;else if(key==="mode")d.mode=val}
async function saveConfig(pid){var g=$("#cfg-msg");if(!g)return;var d=ensureDraft(pid);var dn=($("#cfg-dn")&&$("#cfg-dn").value.trim())||"";var it=Number($("#cfg-int")&&$("#cfg-int").value||5);var tr=Number($("#cfg-tr")&&$("#cfg-tr").value||60);if(dn)d.displayName=dn;d.intervalMin=it;d.trafficSec=tr;g.textContent="保存中…";g.className="form-msg ok";try{await api("/api/profiles/"+encodeURIComponent(pid),{method:"PUT",body:{displayName:d.displayName||undefined,clientProfile:d.clientProfile||"linux",protocol:d.protocol||"ZTE",mode:d.mode||"live",intervalMin:it,trafficSec:tr}});toast("已保存");closeConfigModal();await loadProfiles()}catch(e){g.textContent=humanError(e,"保存失败");g.className="form-msg err"}}

function confirmModal(t,b,o){return new Promise(function(r){var m=$("#modal"),tt=$("#modal-title"),bb=$("#modal-body"),ok=$("#modal-ok"),cc=$("#modal-cancel");if(!m||!ok||!cc){r(window.confirm(b||t));return}tt.textContent=t||"确认";bb.textContent=b||"";ok.textContent=o||"确定";m.classList.remove("hidden");var f=function(v){m.classList.add("hidden");ok.onclick=null;cc.onclick=null;r(v)};ok.onclick=function(){f(true)};cc.onclick=function(){f(false)}})}
async function delAccount(pid){var p=state.profiles.find(function(x){return x.id===pid});var n=(p&&p.displayName)||pid;var ok=await confirmModal("删除账号","确定删除「"+n+"」？","删除");if(!ok)return;state.busy[pid]=true;try{await api("/api/profiles/"+encodeURIComponent(pid),{method:"DELETE"});delete state.drafts[pid];delete state.logs[pid];delete state.desktops[pid];toast("已删除");await loadProfiles()}catch(e){toast(humanError(e,"删除失败"),true)}finally{state.busy[pid]=false;renderAccounts()}}
async function refreshDesktops(pid,quiet){try{var d=await api("/api/profiles/"+encodeURIComponent(pid)+"/desktops?refresh=1");state.desktops[pid]=(d&&(d.desktops||d.items||d.list))||[];if(!quiet)toast("已刷新");renderAccounts()}catch(e){if(!quiet)toast(humanError(e,"刷新失败"),true)}}

async function loadDesktopLogs(pid,did){
  if(!pid||!did)return;
  try{
    var d=await api("/api/profiles/"+encodeURIComponent(pid)+"/logs?desktopId="+encodeURIComponent(did));
    var logs=d&&d.logs&&d.logs[did];
    if(logs){if(!state.logs[pid])state.logs[pid]={};state.logs[pid][did]=logs;applyLogsToDom(pid,did)}
  }catch(_){}
}
async function loadAllDesktopLogs(pid){
  if(!pid)return;
  try{
    var d=await api("/api/profiles/"+encodeURIComponent(pid)+"/logs?all=1");
    var logs=d&&d.logs;
    if(logs&&typeof logs==="object"){
      if(!state.logs[pid])state.logs[pid]={};
      for(var did in logs)state.logs[pid][did]=logs[did];
    }
  }catch(_){}
}

async function loadProfiles(){
  try{
    var d=await api("/api/profiles");
    state.profiles=((d&&d.profiles)||[]).filter(function(p){return p&&!p.draft});
    // Build per-desktop status map from desktopStatuses in profile
    state.deskStatuses={};
    for(var i=0;i<state.profiles.length;i++){
      var p=state.profiles[i];state.deskStatuses[p.id]={};
      var ds=p.desktopStatuses||[];
      for(var j=0;j<ds.length;j++){
        var entry=ds[j];state.deskStatuses[p.id][entry.desktopId]={status:entry.status||"idle",jobId:entry.jobId,protocol:entry.protocol,startedAt:entry.startedAt};
      }
      ensureDraft(p.id,p);
      if(p.userServiceId){
        if(!state.selectedDesktops[p.id])state.selectedDesktops[p.id]=[];
        if(state.selectedDesktops[p.id].indexOf(p.userServiceId)<0)state.selectedDesktops[p.id].push(p.userServiceId)
      }
      if(!state.desktops[p.id]||!state.desktops[p.id].length){
        state.desktops[p.id]=[];
        api("/api/profiles/"+encodeURIComponent(p.id)+"/desktops").then(function(dl){state.desktops[p.id]=(dl&&(dl.desktops||dl.items||dl.list))||[];renderAccounts()}).catch(function(){})
      }
    }
    renderStats();
    if(state.activeTab==="accounts")renderAccounts();else if(state.activeTab==="status")renderStatus();
  }catch(e){toast(humanError(e,"加载失败"),true)}
}

function pollDesktopStatuses(){
  var pids=state.profiles.map(function(p){return p.id});
  for(var i=0;i<pids.length;i++){
    (function(pid){
      var sel=state.selectedDesktops[pid]||[];
      for(var j=0;j<sel.length;j++){
        (function(did){
          api("/api/profiles/"+encodeURIComponent(pid)+"/desktops/"+encodeURIComponent(did)+"/jobs").then(function(d){
            var job=d&&d.job||{};
            if(!state.deskStatuses)state.deskStatuses={};
            if(!state.deskStatuses[pid])state.deskStatuses[pid]={};
            state.deskStatuses[pid][did]={status:job.status||"idle",jobId:job.jobId,protocol:job.protocol,startedAt:job.startedAt};
            // Update status item DOM directly without full re-render
            var c=$('.status-item[data-pid="'+pid+'"][data-desk="'+did+'"]');
            if(c){
              var st=job.status||"idle";
              c.className=c.className.split(/\s+/).filter(function(x){return x.indexOf("status-")!==0}).concat(["status-item","status-"+st]).join(" ");
              var b=c.querySelector(".badge");if(b)b.textContent=statusLabel(st);
              var s=c.querySelector('[onclick*="startOne"]');var t=c.querySelector('[onclick*="stopOne"]');
              if(s&&t){s.style.display=st==="running"?"none":"";t.style.display=st!=="running"?"none":""}
            }
            renderStats();
          }).catch(function(){});
          api("/api/profiles/"+encodeURIComponent(pid)+"/logs?desktopId="+encodeURIComponent(did)+"&limit=50").then(function(d){
            var logs=d&&d.logs&&d.logs[did];
            if(logs){if(!state.logs[pid])state.logs[pid]={};state.logs[pid][did]=logs;applyLogsToDom(pid,did)}
          }).catch(function(){});
        })(sel[j])
      }
    })(pids[i])
  }
}

function loadSys(){try{api("/api/system/info").then(function(i){state.tokenRequired=!!(i&&i.tokenRequired);var e=$("#sys-info");if(e)e.textContent="v"+(i.version||"?")+(state.tokenRequired?" · 需令牌":"")}).catch(function(e){if(e&&(e.status===401))state.tokenRequired=true;var e2=$("#sys-info");if(e2)e2.textContent=state.tokenRequired?"需令牌":""})}catch(e){};var r=$("#token-row");if(r)r.style.display=state.tokenRequired?"flex":"none"}
function clearToken(){setToken("");loadSys();toast("已清除")}
function boot(){
  $$(".tab-item").forEach(function(b){b.addEventListener("click",function(){switchTab(b.getAttribute("data-tab"))})});
  $("#login-modal-close")&&$("#login-modal-close").addEventListener("click",closeLoginModal);
  $("#config-modal-close")&&$("#config-modal-close").addEventListener("click",closeConfigModal);
  $("#btn-add-account")&&$("#btn-add-account").addEventListener("click",function(){openLoginModal("")});
  $("#btn-refresh")&&$("#btn-refresh").addEventListener("click",async function(){var b=$("#btn-refresh");if(b)b.disabled=true;try{await loadProfiles();toast("已刷新")}catch(e){toast("刷新失败",true)}finally{if(b)b.disabled=false}});
  $("#btn-clear-log")&&$("#btn-clear-log").addEventListener("click",function(){state.globalLog=[];renderLogs()});
  $("#btn-help")&&$("#btn-help").addEventListener("click",function(){$("#help-modal").classList.remove("hidden")});
  $("#help-close")&&$("#help-close").addEventListener("click",function(){$("#help-modal").classList.add("hidden")});
  $("#btn-token")&&$("#btn-token").addEventListener("click",function(){var t=($("#token-input")&&$("#token-input").value)||"";if(!t){toast("请输入令牌",true);return}setToken(t);toast("已设置")});
  $("#btn-clear-token")&&$("#btn-clear-token").addEventListener("click",clearToken);
  document.addEventListener("keydown",function(ev){if(ev.key==="Escape"){if($("#login-modal")&&!$("#login-modal").classList.contains("hidden"))closeLoginModal();else if($("#config-modal")&&!$("#config-modal").classList.contains("hidden"))closeConfigModal();else if($("#help-modal")&&!$("#help-modal").classList.contains("hidden"))$("#help-modal").classList.add("hidden")}});
  try{var u=new URL(location.href);var t=u.searchParams.get("token");if(t){setToken(t);u.searchParams.delete("token");history.replaceState({},"",u.pathname+u.search+u.hash)}}catch(_){}
  try{var _g=sessionStorage.getItem("cmcc_gLog");if(_g)state.globalLog=JSON.parse(_g);renderLogs()}catch(_){}
  pushGlobal("云电脑保活管理 · 就绪 (per-desktop)");
  loadSys();loadProfiles();switchTab("accounts");
  setInterval(pollDesktopStatuses,5000);
  setInterval(function(){var ids=state.profiles.map(function(p){return p.id});ids.forEach(function(pid){refreshDesktops(pid,true).catch(function(){})})},30000);
}
window.startKeepalive=startKeepalive;window.delAccount=delAccount;window.refreshDesktops=refreshDesktops;
window.startOne=startOne;window.stopOne=stopOne;
window.doLogin=doLogin;window.setCfgKey=setCfgKey;window.saveConfig=saveConfig;
window.loadDesktopLogs=loadDesktopLogs;
window.openConfigModal=openConfigModal;window.openLoginModal=openLoginModal;
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
})();
