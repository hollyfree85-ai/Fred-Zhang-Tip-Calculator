
import { getApps, getApp, initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { FIREBASE_CONFIG } from "./firebase-config.js";

const app=getApps().length?getApp():initializeApp(FIREBASE_CONFIG);
const auth=getAuth(app);
const db=getFirestore(app);
const COL="hostCashierTipReports";

const HOSTS=[
  ["Cynthia Risner","2566795133"],
  ["Katelyn Ramsey","2055229939"],
  ["Megan Meadows","9314922850"],
  ["Mia Gibson","12563615765"],
  ["Ruwini Rathnayaka","2566521938"],
  ["Sasha Safitri","3347132951"],
  ["Shaniya Scott","13147042742"],
  ["T'Aljah Boyd","2565518870"],
  ["Vidya Caroline","8187494818"]
];

const $=id=>document.getElementById(id);
function enforceDialogClosedState(){
  const credit=document.getElementById("hcCreditCalcModal");
  const sig=document.getElementById("hcSignatureModal");
  if(credit && !credit.dataset.opened) credit.classList.add("hidden");
  if(sig && !sig.dataset.opened) sig.classList.add("hidden");
}
const money=n=>"$"+(Number(n)||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const num=v=>Math.max(0,Number(v)||0);
const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
const today=()=>{const d=new Date(),z=x=>String(x).padStart(2,"0");return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`};

let state={date:today(),cashAM:0,creditAM:0,cashPM:0,creditPM:0,creditAccountsAM:[],creditAccountsPM:[],team:{},employeesAM:Array(7).fill(""),employeesPM:Array(7).fill(""),signatures:{AM:{},PM:{}}};
let unsub=null,dirty=false,sigCtx=null,sigTarget=null,sigStrokes=[],drawing=false,currentStroke=null;

let changeRevision=0,saveInProgress=false;
function markDirty(){dirty=true;changeRevision++;}
const cent=v=>Math.round((Number(v)||0)*100+1e-7);
function allocate(pool,names){
  const sorted=[...names].sort((a,b)=>a.localeCompare(b));
  const cents=cent(pool),n=sorted.length,base=n?Math.floor(cents/n):0,extra=n?cents%n:0;
  return Object.fromEntries(sorted.map((name,i)=>[name,(base+(i<extra?1:0))/100]));
}
function employeeTip(shift,name){const m=calcBase();return (shift==="AM"?m.amountsAM:m.amountsPM)[name]||0;}
function signatureFor(shift,name){
  const sig=state.signatures?.[shift]?.[name];
  if(!sig)return null;
  if(sig.amount!=null && (cent(sig.amount)!==cent(employeeTip(shift,name)) || sig.date!==state.date))return null;
  return sig;
}
let hcProfile=null;
async function refreshHcProfile(){
  const u=auth.currentUser;if(!u){hcProfile=null;return null}
  try{const s=await getDoc(doc(db,"users",u.uid));hcProfile=s.exists()?s.data():null;return hcProfile}catch(e){hcProfile=null;return null}
}
function roleAllowed(){return ["manager","owner"].includes(String(hcProfile?.role||window.__getCurrentRole?.()||""))}
const ROSTER_DOC="__employee_roster__";
let rosterOverrides={},rosterUnsub=null,rosterReady=false,rosterBusy=false,rosterSession=0;
const cleanName=v=>String(v||"").trim().replace(/\s+/g," ");
const nameKey=v=>cleanName(v).toLowerCase();
const rosterEntryKey=name=>Array.from(new TextEncoder().encode(nameKey(name)),b=>b.toString(16).padStart(2,"0")).join("");
function rosterEntries(){
  const entries=new Map(HOSTS.map(([name,phone])=>[nameKey(name),{name,phone,active:true}]));
  for(const u of Object.values(rosterOverrides||{})){
    const name=cleanName(u?.name);
    if(name)entries.set(nameKey(name),{name,phone:String(u.phone||""),active:u.active!==false});
  }
  return [...entries.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
function employeeNames(){return rosterEntries().filter(u=>u.active).map(u=>u.name)}
function optionHtml(selected=""){
  const names=employeeNames();if(selected&&!names.includes(selected))names.push(selected);
  return `<option value="">Select employee</option>`+names.map(x=>`<option ${x===selected?"selected":""} value="${esc(x)}">${esc(x)}</option>`).join("");
}
function rosterStatus(message){if($("hcEmployeeStatus"))$("hcEmployeeStatus").textContent=message;}
function renderEmployeeManager(){
  const host=$("hcEmployeeList");if(!host)return;
  host.innerHTML=rosterEntries().map(u=>`<div class="hc-managed-employee"><div><b>${esc(u.name)}</b>${u.active?'':'<div class="small">Removed from employee list</div>'}</div><button class="btn ${u.active?'red':'light'}" type="button" data-roster-name="${esc(u.name)}" data-roster-active="${u.active?'false':'true'}" ${!rosterReady||rosterBusy?'disabled':''}>${u.active?'Remove':'Restore'}</button></div>`).join('');
  host.querySelectorAll('[data-roster-name]').forEach(btn=>btn.addEventListener('click',()=>{
    const entry=rosterEntries().find(u=>u.name===btn.dataset.rosterName);if(!entry)return;
    const active=btn.dataset.rosterActive==='true';
    if(!active&&!confirm(`Remove ${entry.name} from the Host / Cashier employee list? Saved reports and the current team's payouts stay unchanged. To remove them from today's team, uncheck their name and click Create / Update Team.`))return;
    updateRosterEntry({...entry,active});
  }));
  if($("hcAddEmployeeBtn"))$("hcAddEmployeeBtn").disabled=!rosterReady||rosterBusy;
}
function refreshRosterViews(){renderRoster();renderEmployeeManager();renderRows();calc();}
function listenEmployeeRoster(){
  if(rosterUnsub)rosterUnsub();
  const session=++rosterSession;rosterReady=false;rosterStatus('Loading employee list…');renderEmployeeManager();
  rosterUnsub=onSnapshot(doc(db,COL,ROSTER_DOC),snap=>{
    if(session!==rosterSession)return;
    rosterOverrides=snap.exists()?snap.data().entries||{}:{};rosterReady=true;
    refreshRosterViews();rosterStatus('');
  },e=>{
    if(session!==rosterSession)return;
    rosterReady=false;renderEmployeeManager();rosterStatus(`Employee list could not load: ${e.code||e.message}. Reopen Host / Cashier Tip to retry.`);
  });
}
async function updateRosterEntry(entry){
  if(!roleAllowed()){alert('Manager / Owner only.');return false;}
  if(!rosterReady||rosterBusy)return false;
  const name=cleanName(entry.name),phone=String(entry.phone||'').trim();
  if(!name||name.length>100||/[\u0000-\u001f\u007f]/.test(name)){rosterStatus('Enter a valid employee name (1–100 characters).');return false;}
  const key=rosterEntryKey(name),value={name,phone,active:entry.active!==false};
  const session=rosterSession;rosterBusy=true;renderEmployeeManager();
  try{
    // Merge one employee only so changes from different tablets do not replace
    // the whole roster. This metadata document is separate from dated reports.
    await setDoc(doc(db,COL,ROSTER_DOC),{kind:'host_cashier_roster',entries:{[key]:value},updatedAt:serverTimestamp(),updatedByUid:auth.currentUser?.uid||''},{merge:true});
    if(session!==rosterSession)return true;
    rosterOverrides={...rosterOverrides,[key]:value};refreshRosterViews();
    rosterStatus(value.active?`${name} is available in the employee list.`:`${name} was removed from the employee list. Existing reports and today's team are unchanged.`);
    return true;
  }catch(e){if(session===rosterSession)rosterStatus(`Employee change was not saved: ${e.code||e.message}`);return false;}
  finally{rosterBusy=false;renderEmployeeManager();}
}
async function addRosterEmployee(){
  const name=cleanName($("hcNewEmployeeName")?.value),phone=$("hcNewEmployeePhone")?.value||'';
  const existing=rosterEntries().find(u=>nameKey(u.name)===nameKey(name));
  if(existing?.active){rosterStatus(`${existing.name} is already in the employee list.`);return;}
  if(await updateRosterEntry({name:existing?.name||name,phone:phone||existing?.phone||'',active:true})){
    $("hcNewEmployeeName").value='';$("hcNewEmployeePhone").value='';
  }
}
function renderRoster(){
  const host=$("hcRoster");if(!host)return;
  const entries=rosterEntries().filter(u=>u.active);
  const existingNames=new Set([...namesFor('AM'),...namesFor('PM'),...Object.keys(state.team||{}).filter(n=>state.team[n]?.working)]);
  for(const name of existingNames)if(!entries.some(u=>u.name===name))entries.push({name,phone:'',active:false});
  host.innerHTML=entries.map(({name,phone,active})=>{
    const t=state.team?.[name]||{};
    return `<label class="hc-roster-item">
      <input class="hc-team-check" data-name="${esc(name)}" type="checkbox" ${t.working?"checked":""}/>
      <div><b>${esc(name)}</b><div class="small">${esc(phone)}${active?'':' · Existing report / team'}</div></div>
      <select class="hc-team-shift" data-name="${esc(name)}" ${t.working?"":"disabled"}>
        <option value="AM" ${t.shift==="AM"?"selected":""}>AM</option>
        <option value="PM" ${t.shift==="PM"?"selected":""}>PM</option>
        <option value="DOUBLE" ${t.shift==="DOUBLE"?"selected":""}>DOUBLE</option>
      </select>
    </label>`;
  }).join("");
  host.querySelectorAll(".hc-team-check").forEach(x=>x.addEventListener("change",()=>{
    const name=x.dataset.name,sel=[...host.querySelectorAll(".hc-team-shift")].find(s=>s.dataset.name===name);
    sel.disabled=!x.checked;state.team[name]={working:x.checked,shift:sel.value||"AM"};markDirty();
  }));
  host.querySelectorAll(".hc-team-shift").forEach(x=>x.addEventListener("change",()=>{
    const name=x.dataset.name,ck=[...host.querySelectorAll(".hc-team-check")].find(c=>c.dataset.name===name);
    state.team[name]={working:!!ck.checked,shift:x.value||"AM"};markDirty();
  }));
}
function selectedFromTeam(shift){return Object.entries(state.team||{}).filter(([_,v])=>v?.working&&(v.shift===shift||v.shift==="DOUBLE")).map(([name])=>name)}
function createTeam(){
  const am=selectedFromTeam("AM"),pm=selectedFromTeam("PM");
  if(am.length>7||pm.length>7){alert("Maximum 7 employees per shift.");return}
  state.employeesAM=[...am,...Array(7-am.length).fill("")].slice(0,7);
  state.employeesPM=[...pm,...Array(7-pm.length).fill("")].slice(0,7);
  $("hcBoard")?.classList.remove("hidden");renderRows();calc();markDirty();
}
function namesFor(shift){return [...new Set((shift==="AM"?state.employeesAM:state.employeesPM).filter(Boolean))]}
function renderShiftRows(shift){
  const key=shift==="AM"?"employeesAM":"employeesPM",host=$(shift==="AM"?"hcRowsAM":"hcRowsPM");if(!host)return;
  host.innerHTML=Array.from({length:7},(_,i)=>{
    const name=state[key]?.[i]||"",signed=!!signatureFor(shift,name)?.strokes?.length;
    return `<div class="hc-row"><span class="hc-row-num">${i+1}</span>
      <select class="hc-employee-select" data-index="${i}">${optionHtml(name)}</select>
      <span class="hc-tip" id="hcTip${shift}${i}">$0.00</span>
      <button class="btn light hc-sign-btn ${signed?"hc-signed":""}" type="button" data-shift="${shift}" data-index="${i}" data-name="${esc(name)}">${signed?"✓ Signed":"Sign"}</button></div>`;
  }).join("");
  host.querySelectorAll(".hc-employee-select").forEach(sel=>sel.addEventListener("change",()=>{
    const idx=Number(sel.dataset.index),arr=state[key],val=sel.value;
    if(val&&arr.some((x,j)=>j!==idx&&x===val)){alert(`${val} is already selected in ${shift}.`);sel.value=arr[idx]||"";return}
    arr[idx]=val;markDirty();renderShiftRows(shift);calc();
  }));
}

function combinedPayoutRows(){
  const m=calcBase();
  const map=new Map();
  namesFor("AM").forEach(name=>{
    const row=map.get(name)||{name,am:0,pm:0};
    row.am=m.amountsAM[name];map.set(name,row);
  });
  namesFor("PM").forEach(name=>{
    const row=map.get(name)||{name,am:0,pm:0};
    row.pm=m.amountsPM[name];map.set(name,row);
  });
  return [...map.values()].map(r=>({...r,total:(cent(r.am)+cent(r.pm))/100})).sort((a,b)=>a.name.localeCompare(b.name));
}
function renderCombinedPayout(){
  const rows=combinedPayoutRows(),host=$("hcCombinedRows");
  if(!host)return;
  const total=rows.reduce((s,r)=>s+r.total,0);
  if($("hcCombinedDailyTotal"))$("hcCombinedDailyTotal").textContent=money(total);
  host.innerHTML=rows.length?rows.map(r=>{
    const both=r.am>0&&r.pm>0;
    return `<tr class="${both?"hc-combined-double":""}">
      <td>${esc(r.name)}${both?'<span class="hc-shift-pill double">AM + PM</span>':""}</td>
      <td>${money(r.am)}</td><td>${money(r.pm)}</td><td>${money(r.total)}</td>
    </tr>`;
  }).join(""):`<tr><td colspan="4" class="small">No employees selected.</td></tr>`;
}
function calcBase(){
  const poolAM=(cent(state.cashAM)+cent(state.creditAM))/100,poolPM=(cent(state.cashPM)+cent(state.creditPM))/100;
  const am=namesFor("AM"),pm=namesFor("PM");
  return {poolAM,poolPM,am,pm,amountsAM:allocate(poolAM,am),amountsPM:allocate(poolPM,pm),eachAM:am.length?poolAM/am.length:0,eachPM:pm.length?poolPM/pm.length:0,countAM:am.length,countPM:pm.length};
}

let creditCalcShift=null;
let creditCalcDraft=[];
function creditAccountRowsFor(shift){
  const key=shift==="AM"?"creditAccountsAM":"creditAccountsPM";
  const current=Array.isArray(state[key])?state[key]:[];
  if(current.length)return JSON.parse(JSON.stringify(current));
  const total=shift==="AM"?num(state.creditAM):num(state.creditPM);
  return total>0?[{label:"Account 1",amount:total}]:[{label:"Account 1",amount:0}];
}
function openCreditCalculator(shift){
  creditCalcShift=shift;
  creditCalcDraft=creditAccountRowsFor(shift);
  $("hcCreditCalcTitle").textContent=`Credit ${shift} — Account Calculator`;
  $("hcCreditCalcModal").dataset.opened="1";
  $("hcCreditCalcModal").classList.remove("hidden");
  renderCreditCalcRows();
}
function closeCreditCalculator(){
  $("hcCreditCalcModal").classList.add("hidden");
  delete $("hcCreditCalcModal").dataset.opened;
  creditCalcShift=null;creditCalcDraft=[];
}
function renderCreditCalcRows(){
  const host=$("hcCreditCalcRows");if(!host)return;
  host.innerHTML=creditCalcDraft.map((r,i)=>`<div class="hc-credit-calc-row">
    <span class="hc-acct-num">${i+1}</span>
    <input class="hc-account-label" data-i="${i}" data-k="label" placeholder="Account / terminal name" value="${esc(r.label||`Account ${i+1}`)}"/>
    <input data-i="${i}" data-k="amount" type="number" step="0.01" min="0" inputmode="decimal" value="${num(r.amount)}"/>
    <button class="btn hc-credit-calc-remove" data-remove="${i}" type="button">×</button>
  </div>`).join("");
  host.querySelectorAll("input").forEach(el=>el.addEventListener("input",()=>{
    const i=Number(el.dataset.i),k=el.dataset.k;
    creditCalcDraft[i][k]=k==="amount"?num(el.value):el.value;
    updateCreditCalcTotal();
  }));
  host.querySelectorAll("[data-remove]").forEach(btn=>btn.addEventListener("click",()=>{
    creditCalcDraft.splice(Number(btn.dataset.remove),1);
    if(!creditCalcDraft.length)creditCalcDraft.push({label:"Account 1",amount:0});
    renderCreditCalcRows();
  }));
  updateCreditCalcTotal();
}
function updateCreditCalcTotal(){
  const total=creditCalcDraft.reduce((s,r)=>s+cent(r.amount),0)/100;
  $("hcCreditCalcTotal").textContent=money(total);
}
function addCreditAccount(){
  creditCalcDraft.push({label:`Account ${creditCalcDraft.length+1}`,amount:0});
  renderCreditCalcRows();
}
function confirmCreditCalculator(){
  if(!creditCalcShift)return;
  const total=creditCalcDraft.reduce((s,r)=>s+cent(r.amount),0)/100;
  if(creditCalcShift==="AM"){
    state.creditAccountsAM=JSON.parse(JSON.stringify(creditCalcDraft));
    state.creditAM=total;$("hcCreditAM").value=total.toFixed(2);
  }else{
    state.creditAccountsPM=JSON.parse(JSON.stringify(creditCalcDraft));
    state.creditPM=total;$("hcCreditPM").value=total.toFixed(2);
  }
  markDirty();calc();closeCreditCalculator();
}

function renderRows(){renderShiftRows("AM");renderShiftRows("PM")}
function calc(){
  const m=calcBase(),{poolAM,poolPM,eachAM,eachPM}=m;
  $("hcPoolAM").textContent=money(poolAM);$("hcPoolPM").textContent=money(poolPM);
  $("hcCountAM").textContent=m.countAM;$("hcCountPM").textContent=m.countPM;
  $("hcEachAM").textContent=money(eachAM);$("hcEachPM").textContent=money(eachPM);
  for(let i=0;i<7;i++){
    const a=$(`hcTipAM${i}`),p=$(`hcTipPM${i}`);
    if(a)a.textContent=state.employeesAM[i]?money(m.amountsAM[state.employeesAM[i]]):money(0);
    if(p)p.textContent=state.employeesPM[i]?money(m.amountsPM[state.employeesPM[i]]):money(0);
  }
  setTimeout(renderCombinedPayout,0);
  return {...m};
}
function bindMoney(){
  [["hcCashAM","cashAM"],["hcCashPM","cashPM"]].forEach(([id,key])=>{
    const el=$(id);el.value=state[key]||0;el.oninput=()=>{state[key]=num(el.value);markDirty();calc()};
  });
  $("hcCreditAM").value=num(state.creditAM).toFixed(2);
  $("hcCreditPM").value=num(state.creditPM).toFixed(2);
}
function applyState(data){
  state={date:data?.date||state.date||today(),cashAM:num(data?.cashAM),creditAM:num(data?.creditAM),cashPM:num(data?.cashPM),creditPM:num(data?.creditPM),creditAccountsAM:Array.isArray(data?.creditAccountsAM)?data.creditAccountsAM:[],creditAccountsPM:Array.isArray(data?.creditAccountsPM)?data.creditAccountsPM:[],team:data?.team||{},employeesAM:Array.isArray(data?.employeesAM)?[...data.employeesAM,...Array(7).fill("")].slice(0,7):Array(7).fill(""),employeesPM:Array.isArray(data?.employeesPM)?[...data.employeesPM,...Array(7).fill("")].slice(0,7):Array(7).fill(""),signatures:data?.signatures||{AM:{},PM:{}},savedBy:data?.savedBy||""};
  $("hcDate").value=state.date;renderRoster();bindMoney();
  const hasTeam=namesFor("AM").length||namesFor("PM").length||Object.values(state.team).some(x=>x?.working);
  $("hcBoard").classList.toggle("hidden",!hasTeam);renderRows();calc();dirty=false;
}
function loadDate(){
  if(!roleAllowed())return;
  const date=$("hcDate").value||today();state.date=date;
  if(unsub){unsub();unsub=null}
  unsub=onSnapshot(doc(db,COL,date),snap=>{
    if(dirty)return;
    if(date!==$("hcDate").value)return;
    if(snap.exists())applyState(snap.data());else applyState({date});
  },e=>{$("hcSaveStatus").textContent=`Load failed: ${e.code||e.message}`});
}
async function save(){
  if(!roleAllowed()){alert("Manager / Owner only.");return}
  if(saveInProgress)return;
  const metrics=calc(),profile=window.__getCurrentProfile?.()||{},revision=changeRevision;
  const payload=JSON.parse(JSON.stringify(state));
  payload.date=state.date;
  payload.metrics=metrics;
  payload.combinedPayout=combinedPayoutRows();
  payload.roundingRule="Whole cents; remainder in alphabetical employee order";
  for(const shift of ['AM','PM'])for(const sig of Object.values(payload.signatures?.[shift]||{})){
    sig.strokes=(sig.strokes||[]).map(st=>Array.isArray(st)?{points:st}:st);
  }
  Object.assign(payload,{savedBy:profile.displayName||profile.role||"Staff",savedByUid:auth.currentUser?.uid||"",updatedAt:serverTimestamp()});
  saveInProgress=true;
  try{
    await setDoc(doc(db,COL,payload.date),payload,{merge:false});
    if(revision===changeRevision && payload.date===state.date)dirty=false;
    $("hcSaveStatus").textContent=dirty?"Saved. Newer changes still need Save.":`Saved ${payload.date} by ${payload.savedBy}.`;
  }catch(e){alert(`Save failed: ${e.code||e.message}`)}
  finally{saveInProgress=false;}
}

window.hostCashierCloseWorkspace=function(){
  if(unsub){unsub();unsub=null;}
  if(rosterUnsub){rosterUnsub();rosterUnsub=null;}
  rosterSession++;rosterReady=false;rosterOverrides={};
  hcProfile=null;dirty=false;changeRevision++;
  closeSignature();closeCreditCalculator();
  state={date:today(),cashAM:0,creditAM:0,cashPM:0,creditPM:0,creditAccountsAM:[],creditAccountsPM:[],team:{},employeesAM:Array(7).fill(""),employeesPM:Array(7).fill(""),signatures:{AM:{},PM:{}}};
  applyState(state);
};

function setupCanvas(){
  const c=$("hcSignatureCanvas");if(!c)return;if(c.dataset.bound==="1"){sigCtx=c.getContext("2d");return;}c.dataset.bound="1";sigCtx=c.getContext("2d");sigCtx.lineWidth=3;sigCtx.lineCap="round";sigCtx.strokeStyle="#102b43";
  const point=e=>{const r=c.getBoundingClientRect(),t=e.touches?.[0]||e;return{x:(t.clientX-r.left)/r.width,y:(t.clientY-r.top)/r.height}};
  const down=e=>{e.preventDefault();drawing=true;currentStroke=[];sigStrokes.push(currentStroke);currentStroke.push(point(e));redrawSig()};
  const move=e=>{if(!drawing)return;e.preventDefault();currentStroke.push(point(e));redrawSig()};
  const up=e=>{if(!drawing)return;e.preventDefault();drawing=false;currentStroke=null};
  c.addEventListener("pointerdown",down);c.addEventListener("pointermove",move);window.addEventListener("pointerup",up);
}
function redrawSig(){
  const c=$("hcSignatureCanvas");sigCtx.clearRect(0,0,c.width,c.height);sigCtx.strokeStyle="#102b43";sigCtx.lineWidth=3;sigCtx.lineCap="round";sigCtx.lineJoin="round";
  for(const raw of sigStrokes){const stroke=Array.isArray(raw)?raw:raw.points;if(!stroke?.length)continue;sigCtx.beginPath();stroke.forEach((p,i)=>{const x=p.x*c.width,y=p.y*c.height;i?sigCtx.lineTo(x,y):sigCtx.moveTo(x,y)});sigCtx.stroke()}
}
function openSignature(shift,name){
  const modal=$("hcSignatureModal");
  const canvas=$("hcSignatureCanvas");
  if(!modal||!canvas){alert("Signature pad is unavailable.");return;}
  if(!sigCtx){
    setupCanvas();
  }
  sigTarget={shift,name};
  sigStrokes=JSON.parse(JSON.stringify(signatureFor(shift,name)?.strokes||[])).map(st=>Array.isArray(st)?st:st.points||[]);
  $("hcSignatureTitle").textContent=`${name} — ${shift} Signature`;
  modal.dataset.opened="1";
  modal.classList.remove("hidden");
  requestAnimationFrame(()=>{try{redrawSig()}catch(e){console.error("Signature redraw:",e)}});
}
function closeSignature(){$("hcSignatureModal").classList.add("hidden");delete $("hcSignatureModal").dataset.opened;sigTarget=null}
function saveSignature(){if(!sigTarget)return;if(!sigStrokes.some(st=>st.length>1)){alert("Please sign before saving.");return;}state.signatures ||= {AM:{},PM:{}};state.signatures[sigTarget.shift] ||= {};state.signatures[sigTarget.shift][sigTarget.name]={strokes:sigStrokes.map(points=>({points})),amount:employeeTip(sigTarget.shift,sigTarget.name),date:state.date,signedAt:new Date().toISOString()};markDirty();closeSignature();renderRows();calc()}

function xmlEsc(v){return String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function xlsBlob(){
  const m=calc(),rows=[["Date",state.date],["Cash AM",num(state.cashAM)],["Credit AM",num(state.creditAM)],["AM Pool",m.poolAM],["AM Employees",m.countAM],["AM Tip / Employee",m.eachAM],[],["AM Employee","Tip","Signature"]];
  namesFor("AM").forEach(name=>rows.push([name,m.amountsAM[name],signatureFor("AM",name)?.strokes?.length?"SIGNED":"NOT SIGNED"]));
  rows.push([],["Cash PM",num(state.cashPM)],["Credit PM",num(state.creditPM)],["PM Pool",m.poolPM],["PM Employees",m.countPM],["PM Tip / Employee",m.eachPM],[],["PM Employee","Tip","Signature"]);
  namesFor("PM").forEach(name=>rows.push([name,m.amountsPM[name],signatureFor("PM",name)?.strokes?.length?"SIGNED":"NOT SIGNED"]));
  rows.push([],["COMBINED EMPLOYEE PAYOUT"],["Employee","AM","PM","Total"]);
  combinedPayoutRows().forEach(r=>rows.push([r.name,r.am,r.pm,r.total]));
  const xmlRows=rows.map(r=>`<Row>${r.map(v=>typeof v==="number"?`<Cell><Data ss:Type="Number">${v}</Data></Cell>`:`<Cell><Data ss:Type="String">${xmlEsc(v)}</Data></Cell>`).join("")}</Row>`).join("");
  return new Blob([`<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Host Cashier Tip"><Table>${xmlRows}</Table></Worksheet></Workbook>`],{type:"application/vnd.ms-excel"});
}

function pdfEsc(s){return String(s??"").replace(/\\/g,"\\\\").replace(/\(/g,"\\(").replace(/\)/g,"\\)")}
function pdfText(font,size,x,y,s){return `BT /${font} ${size} Tf ${x} ${y} Td (${pdfEsc(s)}) Tj ET\n`}
function sigCommands(sig,x,y,w,h){const strokes=sig?.strokes||[];let out="0.08 0.16 0.25 RG 1.4 w\n";for(const raw of strokes){const st=Array.isArray(raw)?raw:raw.points;if(!st?.length)continue;st.forEach((p,i)=>{const px=x+p.x*w,py=y+(1-p.y)*h;out+=`${px.toFixed(1)} ${py.toFixed(1)} ${i?"l":"m"}\n`});out+="S\n"}return out}
function pdfPage(shift){
  const m=calc(),isAM=shift==="AM",names=namesFor(shift),each=isAM?m.eachAM:m.eachPM,cash=isAM?num(state.cashAM):num(state.cashPM),credit=isAM?num(state.creditAM):num(state.creditPM),pool=isAM?m.poolAM:m.poolPM;
  let c="";c+=pdfText("F2",19,34,748,"FRED ZHANG JUST TIP CALCULATOR");c+=pdfText("F2",15,34,723,`HOST / CASHIER TIP REPORT - ${shift}`);c+=pdfText("F1",10,34,704,`Date: ${state.date}   Cash: ${money(cash)}   Credit: ${money(credit)}   Pool: ${money(pool)}`);c+=pdfText("F1",10,34,687,`Employees: ${names.length}   Average share: ${money(each)}`);c+="0.75 w 34 676 m 578 676 l S\n";
  let y=640;names.forEach((name,i)=>{c+=pdfText("F2",11,40,y+18,`${i+1}. ${name}`);c+=pdfText("F2",11,290,y+18,money(employeeTip(shift,name)));c+=pdfText("F1",8,390,y+30,"EMPLOYEE SIGNATURE");c+=`0.65 w 390 ${y-10} 180 48 re S\n`;c+=sigCommands(signatureFor(shift,name),396,y-5,168,38);c+=pdfText("F1",8,40,y-4,signatureFor(shift,name)?.strokes?.length?"SIGNED":"SIGNATURE PENDING");y-=76});
  c+=pdfText("F1",8,34,26,`Generated ${new Date().toLocaleString()} | ${shift} report`);return c;
}
function pdfCombinedPage(){
  const rows=combinedPayoutRows();
  let c=pdfText("F2",19,34,748,"FRED ZHANG TIP CALCULATOR");
  c+=pdfText("F2",15,34,721,"HOST / CASHIER - COMBINED PAYOUT");
  c+=pdfText("F1",11,34,698,`Date: ${state.date}`);
  c+=pdfText("F2",11,34,667,"Employee")+pdfText("F2",11,312,667,"AM")+pdfText("F2",11,397,667,"PM")+pdfText("F2",11,489,667,"Total");
  rows.forEach((r,i)=>{const y=634-i*39;c+=pdfText("F1",11,34,y,r.name)+pdfText("F1",11,312,y,money(r.am))+pdfText("F1",11,397,y,money(r.pm))+pdfText("F2",11,489,y,money(r.total));});
  const total=rows.reduce((sum,r)=>sum+cent(r.total),0)/100;
  c+=pdfText("F2",13,34,210,`TOTAL TO PAY: ${money(total)}`);
  c+=pdfText("F1",9,34,183,"Shares are allocated in whole cents. Remainder cents follow alphabetical order.");
  c+=pdfText("F1",9,34,166,"AM and PM signatures are on their respective shift report pages.");
  return c;
}
function pdfBlob(){
  const pages=[pdfPage("AM"),pdfPage("PM"),pdfCombinedPage()],objects=[],kids=[],font1=3+pages.length*2,font2=font1+1;objects[1]="<< /Type /Catalog /Pages 2 0 R >>";
  pages.forEach((content,i)=>{const pageObj=3+i*2,contentObj=4+i*2;kids.push(`${pageObj} 0 R`);objects[pageObj]=`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> /Contents ${contentObj} 0 R >>`;objects[contentObj]=`<< /Length ${content.length} >>\nstream\n${content}\nendstream`});
  objects[2]=`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;objects[font1]="<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 126 /Widths [278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584] >>";objects[font2]="<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 126 /Widths [278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584] >>";
  let pdf="%PDF-1.4\n",offsets=[0],max=font2;for(let i=1;i<=max;i++){offsets[i]=pdf.length;pdf+=`${i} 0 obj\n${objects[i]}\nendobj\n`}const xref=pdf.length;pdf+=`xref\n0 ${max+1}\n0000000000 65535 f \n`;for(let i=1;i<=max;i++)pdf+=String(offsets[i]).padStart(10,"0")+" 00000 n \n";pdf+=`trailer\n<< /Size ${max+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return new Blob([pdf],{type:"application/pdf"});
}
function download(blob,name){const a=document.createElement("a"),u=URL.createObjectURL(blob);a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),2500)}
async function share(blob,name,target){const file=new File([blob],name,{type:blob.type});if(navigator.share&&navigator.canShare?.({files:[file]})){try{await navigator.share({files:[file],title:"Host / Cashier Tip Report",text:`Host / Cashier Tip report ${state.date}`});return}catch(e){if(e.name==="AbortError")return}}download(blob,name);alert(`The PDF was downloaded. Attach it to ${target==="whatsapp"?"WhatsApp":"your email"} on this browser.`)}



window.hostCashierCreditCalc=function(shift){
  try{ openCreditCalculator(String(shift||"AM").toUpperCase()); }
  catch(e){ console.error("Host/Cashier credit calculator:",e); alert("Credit calculator could not open: "+(e.message||e)); }
};
window.hostCashierSignature=function(shift,name){
  try{
    const s=String(shift||"AM").toUpperCase();
    const n=String(name||"").trim();
    if(!n){alert("Select an employee first.");return;}
    openSignature(s,n);
  }catch(e){
    console.error("Host/Cashier signature:",e);
    alert("Signature could not open: "+(e.message||e));
  }
};

window.hostCashierOpenWorkspace=async function(){
  await refreshHcProfile();
  if(!roleAllowed()){alert("Host / Cashier Tip access is Manager / Owner only.");return;}
  document.querySelectorAll(".staffPanel").forEach(x=>x.classList.add("hidden"));
  document.getElementById("staffArea")?.classList.remove("hidden");
  document.getElementById("hostCashierTip")?.classList.remove("hidden");
  listenEmployeeRoster();
  if(!dirty)loadDate();
};


document.addEventListener("click",function(e){
  const btn=e.target.closest?.("button");
  if(!btn)return;

  if(btn.id==="hcCreditAMCalcBtn"){ e.preventDefault(); openCreditCalculator("AM"); return; }
  if(btn.id==="hcCreditPMCalcBtn"){ e.preventDefault(); openCreditCalculator("PM"); return; }

  if(btn.classList.contains("hc-sign-btn")){
    e.preventDefault();
    e.stopPropagation();
    const shift=String(btn.dataset.shift||"AM").toUpperCase();
    const idx=Number(btn.dataset.index||0);
    const arr=shift==="PM"?state.employeesPM:state.employeesAM;
    const row=btn.closest(".hc-row");
    const liveName=row?.querySelector(".hc-employee-select")?.value||arr?.[idx]||btn.dataset.name||"";
    if(!liveName){alert("Select an employee first.");return;}
    openSignature(shift,liveName);
    return;
  }
});

function init(){
  enforceDialogClosedState();
  if(!$("hcDate"))return;
  $("hcDate").value=state.date;renderRoster();bindMoney();renderRows();setupCanvas();
  $("hcAddEmployeeBtn")?.addEventListener("click",addRosterEmployee);renderEmployeeManager();
  $("hcCreditAM")?.addEventListener("click",()=>openCreditCalculator("AM"));
  $("hcCreditPM")?.addEventListener("click",()=>openCreditCalculator("PM"));
  $("hcCreditAMCalcBtn")?.addEventListener("click",()=>openCreditCalculator("AM"));
  $("hcCreditPMCalcBtn")?.addEventListener("click",()=>openCreditCalculator("PM"));
  $("hcCreditCalcClose")?.addEventListener("click",closeCreditCalculator);
  $("hcCreditCalcCancel")?.addEventListener("click",closeCreditCalculator);
  $("hcCreditCalcAdd")?.addEventListener("click",addCreditAccount);
  $("hcCreditCalcOk")?.addEventListener("click",confirmCreditCalculator);
  $("hcDate").addEventListener("change",()=>{if(dirty&&!confirm("Discard unsaved Host/Cashier changes and open another date?")){$("hcDate").value=state.date;return}state.date=$("hcDate").value;dirty=false;loadDate()});
  $("hcCreateTeamBtn").addEventListener("click",createTeam);$("hcSaveBtn").addEventListener("click",save);$("hcReloadBtn").addEventListener("click",()=>{dirty=false;loadDate()});
  $("hcSigClose").addEventListener("click",closeSignature);$("hcSigClear").addEventListener("click",()=>{sigStrokes=[];redrawSig()});$("hcSigSave").addEventListener("click",saveSignature);
  $("hcXlsBtn").addEventListener("click",()=>download(xlsBlob(),`Fred_Zhang_Host_Cashier_Tip_${state.date}.xls`));
  $("hcPdfBtn").addEventListener("click",()=>download(pdfBlob(),`Fred_Zhang_Host_Cashier_Tip_${state.date}.pdf`));
  $("hcEmailBtn").addEventListener("click",()=>share(pdfBlob(),`Fred_Zhang_Host_Cashier_Tip_${state.date}.pdf`,"email"));
  $("hcWhatsAppBtn").addEventListener("click",()=>share(pdfBlob(),`Fred_Zhang_Host_Cashier_Tip_${state.date}.pdf`,"whatsapp"));
}
if(document.readyState==="loading"){
  document.addEventListener("DOMContentLoaded",init,{once:true});
}else{
  init();
}
