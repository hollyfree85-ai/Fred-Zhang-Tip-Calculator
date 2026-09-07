
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

let hcProfile=null;
async function refreshHcProfile(){
  const u=auth.currentUser;if(!u){hcProfile=null;return null}
  try{const s=await getDoc(doc(db,"users",u.uid));hcProfile=s.exists()?s.data():null;return hcProfile}catch(e){hcProfile=null;return null}
}
function roleAllowed(){return ["manager","owner"].includes(String(hcProfile?.role||window.__getCurrentRole?.()||""))}
function employeeNames(){return HOSTS.map(x=>x[0])}
function optionHtml(selected=""){return `<option value="">Select employee</option>`+employeeNames().map(x=>`<option ${x===selected?"selected":""} value="${esc(x)}">${esc(x)}</option>`).join("")}
function renderRoster(){
  const host=$("hcRoster");if(!host)return;
  host.innerHTML=HOSTS.map(([name,phone])=>{
    const t=state.team?.[name]||{};
    return `<label class="hc-roster-item">
      <input class="hc-team-check" data-name="${esc(name)}" type="checkbox" ${t.working?"checked":""}/>
      <div><b>${esc(name)}</b><div class="small">${esc(phone)}</div></div>
      <select class="hc-team-shift" data-name="${esc(name)}" ${t.working?"":"disabled"}>
        <option value="AM" ${t.shift==="AM"?"selected":""}>AM</option>
        <option value="PM" ${t.shift==="PM"?"selected":""}>PM</option>
        <option value="DOUBLE" ${t.shift==="DOUBLE"?"selected":""}>DOUBLE</option>
      </select>
    </label>`;
  }).join("");
  host.querySelectorAll(".hc-team-check").forEach(x=>x.addEventListener("change",()=>{
    const name=x.dataset.name,sel=[...host.querySelectorAll(".hc-team-shift")].find(s=>s.dataset.name===name);
    sel.disabled=!x.checked;state.team[name]={working:x.checked,shift:sel.value||"AM"};dirty=true;
  }));
  host.querySelectorAll(".hc-team-shift").forEach(x=>x.addEventListener("change",()=>{
    const name=x.dataset.name,ck=[...host.querySelectorAll(".hc-team-check")].find(c=>c.dataset.name===name);
    state.team[name]={working:!!ck.checked,shift:x.value||"AM"};dirty=true;
  }));
}
function selectedFromTeam(shift){return Object.entries(state.team||{}).filter(([_,v])=>v?.working&&(v.shift===shift||v.shift==="DOUBLE")).map(([name])=>name)}
function createTeam(){
  const am=selectedFromTeam("AM"),pm=selectedFromTeam("PM");
  if(am.length>7||pm.length>7){alert("Maximum 7 employees per shift.");return}
  state.employeesAM=[...am,...Array(7-am.length).fill("")].slice(0,7);
  state.employeesPM=[...pm,...Array(7-pm.length).fill("")].slice(0,7);
  $("hcBoard")?.classList.remove("hidden");renderRows();calc();dirty=true;
}
function namesFor(shift){return [...new Set((shift==="AM"?state.employeesAM:state.employeesPM).filter(Boolean))]}
function renderShiftRows(shift){
  const key=shift==="AM"?"employeesAM":"employeesPM",host=$(shift==="AM"?"hcRowsAM":"hcRowsPM");if(!host)return;
  host.innerHTML=Array.from({length:7},(_,i)=>{
    const name=state[key]?.[i]||"",signed=!!state.signatures?.[shift]?.[name]?.strokes?.length;
    return `<div class="hc-row"><span class="hc-row-num">${i+1}</span>
      <select class="hc-employee-select" data-index="${i}">${optionHtml(name)}</select>
      <span class="hc-tip" id="hcTip${shift}${i}">$0.00</span>
      <button class="btn light hc-sign-btn ${signed?"hc-signed":""}" type="button" data-shift="${shift}" data-index="${i}" data-name="${esc(name)}">${signed?"✓ Signed":"Sign"}</button></div>`;
  }).join("");
  host.querySelectorAll(".hc-employee-select").forEach(sel=>sel.addEventListener("change",()=>{
    const idx=Number(sel.dataset.index),arr=state[key],val=sel.value;
    if(val&&arr.some((x,j)=>j!==idx&&x===val)){alert(`${val} is already selected in ${shift}.`);sel.value=arr[idx]||"";return}
    arr[idx]=val;dirty=true;calc();renderShiftRows(shift);
  }));
}

function combinedPayoutRows(){
  const m=calcBase();
  const map=new Map();
  namesFor("AM").forEach(name=>{
    const row=map.get(name)||{name,am:0,pm:0};
    row.am=m.eachAM;map.set(name,row);
  });
  namesFor("PM").forEach(name=>{
    const row=map.get(name)||{name,am:0,pm:0};
    row.pm=m.eachPM;map.set(name,row);
  });
  return [...map.values()].map(r=>({...r,total:r.am+r.pm})).sort((a,b)=>a.name.localeCompare(b.name));
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
  const poolAM=num(state.cashAM)+num(state.creditAM),poolPM=num(state.cashPM)+num(state.creditPM);
  const am=namesFor("AM"),pm=namesFor("PM");
  return {poolAM,poolPM,am,pm,eachAM:am.length?poolAM/am.length:0,eachPM:pm.length?poolPM/pm.length:0,countAM:am.length,countPM:pm.length};
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
  const total=creditCalcDraft.reduce((s,r)=>s+num(r.amount),0);
  $("hcCreditCalcTotal").textContent=money(total);
}
function addCreditAccount(){
  creditCalcDraft.push({label:`Account ${creditCalcDraft.length+1}`,amount:0});
  renderCreditCalcRows();
}
function confirmCreditCalculator(){
  if(!creditCalcShift)return;
  const total=creditCalcDraft.reduce((s,r)=>s+num(r.amount),0);
  if(creditCalcShift==="AM"){
    state.creditAccountsAM=JSON.parse(JSON.stringify(creditCalcDraft));
    state.creditAM=total;$("hcCreditAM").value=total.toFixed(2);
  }else{
    state.creditAccountsPM=JSON.parse(JSON.stringify(creditCalcDraft));
    state.creditPM=total;$("hcCreditPM").value=total.toFixed(2);
  }
  dirty=true;calc();closeCreditCalculator();
}

function renderRows(){renderShiftRows("AM");renderShiftRows("PM")}
function calc(){
  const m=calcBase(),{poolAM,poolPM,eachAM,eachPM}=m;
  $("hcPoolAM").textContent=money(poolAM);$("hcPoolPM").textContent=money(poolPM);
  $("hcCountAM").textContent=m.countAM;$("hcCountPM").textContent=m.countPM;
  $("hcEachAM").textContent=money(eachAM);$("hcEachPM").textContent=money(eachPM);
  for(let i=0;i<7;i++){
    const a=$(`hcTipAM${i}`),p=$(`hcTipPM${i}`);
    if(a)a.textContent=state.employeesAM[i]?money(eachAM):money(0);
    if(p)p.textContent=state.employeesPM[i]?money(eachPM):money(0);
  }
  setTimeout(renderCombinedPayout,0);
  return {poolAM,poolPM,eachAM,eachPM,countAM:m.countAM,countPM:m.countPM};
}
function bindMoney(){
  [["hcCashAM","cashAM"],["hcCashPM","cashPM"]].forEach(([id,key])=>{
    const el=$(id);el.value=state[key]||0;el.oninput=()=>{state[key]=num(el.value);dirty=true;calc()};
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
    if(snap.exists())applyState(snap.data());else applyState({date});
  },e=>{$("hcSaveStatus").textContent=`Load failed: ${e.code||e.message}`});
}
async function save(){
  if(!roleAllowed()){alert("Manager / Owner only.");return}
  const metrics=calc(),profile=window.__getCurrentProfile?.()||{};
  const payload={...state,date:$("hcDate").value||today(),cashAM:num($("hcCashAM").value),creditAM:num(state.creditAM),cashPM:num($("hcCashPM").value),creditPM:num(state.creditPM),metrics,savedBy:profile.displayName||profile.role||"Staff",savedByUid:auth.currentUser?.uid||"",updatedAt:serverTimestamp()};
  try{await setDoc(doc(db,COL,payload.date),payload,{merge:false});dirty=false;$("hcSaveStatus").textContent=`Saved ${new Date().toLocaleString()} by ${payload.savedBy}.`}catch(e){alert(`Save failed: ${e.code||e.message}`)}
}

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
  for(const stroke of sigStrokes){if(!stroke?.length)continue;sigCtx.beginPath();stroke.forEach((p,i)=>{const x=p.x*c.width,y=p.y*c.height;i?sigCtx.lineTo(x,y):sigCtx.moveTo(x,y)});sigCtx.stroke()}
}
function openSignature(shift,name){
  const modal=$("hcSignatureModal");
  const canvas=$("hcSignatureCanvas");
  if(!modal||!canvas){alert("Signature pad is unavailable.");return;}
  if(!sigCtx){
    setupCanvas();
  }
  sigTarget={shift,name};
  sigStrokes=JSON.parse(JSON.stringify(state.signatures?.[shift]?.[name]?.strokes||[]));
  $("hcSignatureTitle").textContent=`${name} — ${shift} Signature`;
  modal.dataset.opened="1";
  modal.classList.remove("hidden");
  requestAnimationFrame(()=>{try{redrawSig()}catch(e){console.error("Signature redraw:",e)}});
}
function closeSignature(){$("hcSignatureModal").classList.add("hidden");delete $("hcSignatureModal").dataset.opened;sigTarget=null}
function saveSignature(){if(!sigTarget)return;state.signatures ||= {AM:{},PM:{}};state.signatures[sigTarget.shift] ||= {};state.signatures[sigTarget.shift][sigTarget.name]={strokes:sigStrokes,signedAt:new Date().toISOString()};dirty=true;closeSignature();renderRows()}

function xmlEsc(v){return String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function xlsBlob(){
  const m=calc(),rows=[["Date",state.date],["Cash AM",num(state.cashAM)],["Credit AM",num(state.creditAM)],["AM Pool",m.poolAM],["AM Employees",m.countAM],["AM Tip / Employee",m.eachAM],[],["AM Employee","Tip","Signature"]];
  namesFor("AM").forEach(name=>rows.push([name,m.eachAM,state.signatures?.AM?.[name]?.strokes?.length?"SIGNED":"NOT SIGNED"]));
  rows.push([],["Cash PM",num(state.cashPM)],["Credit PM",num(state.creditPM)],["PM Pool",m.poolPM],["PM Employees",m.countPM],["PM Tip / Employee",m.eachPM],[],["PM Employee","Tip","Signature"]);
  namesFor("PM").forEach(name=>rows.push([name,m.eachPM,state.signatures?.PM?.[name]?.strokes?.length?"SIGNED":"NOT SIGNED"]));
  rows.push([],["COMBINED EMPLOYEE PAYOUT"],["Employee","AM","PM","Total"]);
  combinedPayoutRows().forEach(r=>rows.push([r.name,r.am,r.pm,r.total]));
  const xmlRows=rows.map(r=>`<Row>${r.map(v=>typeof v==="number"?`<Cell><Data ss:Type="Number">${v}</Data></Cell>`:`<Cell><Data ss:Type="String">${xmlEsc(v)}</Data></Cell>`).join("")}</Row>`).join("");
  return new Blob([`<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Host Cashier Tip"><Table>${xmlRows}</Table></Worksheet></Workbook>`],{type:"application/vnd.ms-excel"});
}

function pdfEsc(s){return String(s??"").replace(/\\/g,"\\\\").replace(/\(/g,"\\(").replace(/\)/g,"\\)")}
function pdfText(font,size,x,y,s){return `BT /${font} ${size} Tf ${x} ${y} Td (${pdfEsc(s)}) Tj ET\n`}
function sigCommands(sig,x,y,w,h){const strokes=sig?.strokes||[];let out="0.08 0.16 0.25 RG 1.4 w\n";for(const st of strokes){if(!st?.length)continue;st.forEach((p,i)=>{const px=x+p.x*w,py=y+(1-p.y)*h;out+=`${px.toFixed(1)} ${py.toFixed(1)} ${i?"l":"m"}\n`});out+="S\n"}return out}
function pdfPage(shift){
  const m=calc(),isAM=shift==="AM",names=namesFor(shift),each=isAM?m.eachAM:m.eachPM,cash=isAM?num(state.cashAM):num(state.cashPM),credit=isAM?num(state.creditAM):num(state.creditPM),pool=isAM?m.poolAM:m.poolPM;
  let c="";c+=pdfText("F2",19,34,748,"FRED ZHANG JUST TIP CALCULATOR");c+=pdfText("F2",15,34,723,`HOST / CASHIER TIP REPORT - ${shift}`);c+=pdfText("F1",10,34,704,`Date: ${state.date}   Cash: ${money(cash)}   Credit: ${money(credit)}   Pool: ${money(pool)}`);c+=pdfText("F1",10,34,687,`Employees: ${names.length}   Tip per Employee: ${money(each)}`);c+="0.75 w 34 676 m 578 676 l S\n";
  let y=640;names.forEach((name,i)=>{c+=pdfText("F2",11,40,y+18,`${i+1}. ${name}`);c+=pdfText("F2",11,290,y+18,money(each));c+=pdfText("F1",8,390,y+30,"EMPLOYEE SIGNATURE");c+=`0.65 w 390 ${y-10} 180 48 re S\n`;c+=sigCommands(state.signatures?.[shift]?.[name],396,y-5,168,38);c+=pdfText("F1",8,40,y-4,state.signatures?.[shift]?.[name]?.strokes?.length?"SIGNED":"SIGNATURE PENDING");y-=76});
  if(shift==="PM"){
    const combined=combinedPayoutRows();
    let cy=150;
    c+=pdfText("F2",11,34,cy+18,"COMBINED EMPLOYEE PAYOUT");
    combined.slice(0,7).forEach((r,i)=>{
      c+=pdfText("F1",9,40,cy-i*16,`${r.name}: ${money(r.total)}${r.am>0&&r.pm>0?" (AM + PM)":""}`);
    });
  }
  c+=pdfText("F1",8,34,26,`Generated ${new Date().toLocaleString()} | ${shift} report`);return c;
}
function pdfBlob(){
  const pages=[pdfPage("AM"),pdfPage("PM")],objects=[],kids=[],font1=7,font2=8;objects[1]="<< /Type /Catalog /Pages 2 0 R >>";
  pages.forEach((content,i)=>{const pageObj=3+i*2,contentObj=4+i*2;kids.push(`${pageObj} 0 R`);objects[pageObj]=`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> /Contents ${contentObj} 0 R >>`;objects[contentObj]=`<< /Length ${content.length} >>\nstream\n${content}\nendstream`});
  objects[2]=`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;objects[font1]="<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";objects[font2]="<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
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
  loadDate();
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
