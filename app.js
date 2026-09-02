import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, limit, onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { FIREBASE_CONFIG } from "./firebase-config.js";

const firebaseApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

let currentUser = null;
let currentProfile = null;
let eShift = "AM";
let unsubs = [];
let latestRows = [];
let knownPending = new Set();

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[m]));

function todayLocal(){
  const d=new Date(), z=n=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`;
}
function emailFor(username){
  return `${String(username).trim().toLowerCase().replace(/[^a-z0-9._-]/g,"")}@juicytip.app`;
}
// Firebase requires passwords >= 6 characters. Employees still type only their PIN.
function employeeAuthPassword(pin){
  return `JT${String(pin).trim()}!!`;
}
function loginMsg(m){ $("loginMessage").textContent = m || ""; }

window.setLoginMode = function(mode){
  $("employeeLogin").classList.toggle("hidden", mode !== "employee");
  $("staffLogin").classList.toggle("hidden", mode !== "staff");
  $("employeeModeBtn").classList.toggle("on", mode === "employee");
  $("staffModeBtn").classList.toggle("on", mode === "staff");
  loginMsg("");
};

window.loginEmployee = async function(){
  const username = $("employeeUsername").value.trim();
  const pin = $("employeePin").value.trim();
  if(!username || !pin){ loginMsg("Enter username and PIN."); return; }
  try{
    loginMsg("Signing in...");
    await signInWithEmailAndPassword(auth, emailFor(username), employeeAuthPassword(pin));
  }catch(e){
    console.error("Employee login:", e);
    loginMsg(`Login failed: ${e.code || "invalid-login"}`);
  }
};

window.loginStaff = async function(){
  const username = $("staffUsername").value.trim();
  const password = $("staffPassword").value;
  if(!username || !password){ loginMsg("Enter username and password."); return; }
  try{
    loginMsg("Signing in...");
    await signInWithEmailAndPassword(auth, emailFor(username), password);
  }catch(e){
    console.error("Staff login:", e);
    loginMsg(`Login failed: ${e.code || "invalid-login"}`);
  }
};

window.logout = async function(){
  await signOut(auth);
};

async function loadProfile(uid){
  const snap = await getDoc(doc(db,"users",uid));
  return snap.exists() ? snap.data() : null;
}
function clearListeners(){
  unsubs.forEach(fn=>{ try{fn()}catch(e){} });
  unsubs=[];
}
function hideApp(){
  $("loginView").classList.remove("hidden");
  $("appView").classList.add("hidden");
  $("top").classList.add("hidden");
}
function showApp(){
  $("loginView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  $("top").classList.remove("hidden");
  $("whoText").textContent=currentProfile.displayName || currentProfile.username;
  $("rolePill").textContent=String(currentProfile.role).toUpperCase();

  const emp=currentProfile.role==="employee";
  $("employeeApp").classList.toggle("hidden",!emp);
  $("staffApp").classList.toggle("hidden",emp);
  $("employeeBottom").classList.toggle("hidden",!emp);
  document.querySelectorAll(".ownerOnly").forEach(el=>el.classList.toggle("hidden",currentProfile.role!=="owner"));

  if(emp) listenEmployee();
  else listenStaff();
}

onAuthStateChanged(auth, async user=>{
  clearListeners();
  if(!user){
    currentUser=null; currentProfile=null; hideApp(); return;
  }
  try{
    const profile=await loadProfile(user.uid);
    if(!profile){
      loginMsg("Account exists but no JUICY TIP profile was found.");
      await signOut(auth); return;
    }
    if(profile.active===false){
      loginMsg("This account is disabled.");
      await signOut(auth); return;
    }
    currentUser=user;
    currentProfile=profile;
    loginMsg("");
    showApp();
  }catch(e){
    console.error("Profile load:",e);
    loginMsg(`Profile load failed: ${e.code || e.message}`);
    await signOut(auth);
  }
});

// Employee shift UI
document.querySelectorAll("[data-eshift]").forEach(btn=>{
  btn.addEventListener("click",()=>{
    eShift=btn.dataset.eshift;
    document.querySelectorAll("[data-eshift]").forEach(x=>x.classList.remove("on"));
    btn.classList.add("on");
    refreshClockMode();
  });
});
$("eBreakMode").addEventListener("change",refreshClockMode);

function refreshClockMode(){
  const multi=["DOUBLE","LONG"].includes(eShift);
  $("singleClock").classList.toggle("hidden",multi);
  $("longDoubleOptions").classList.toggle("hidden",!multi);
  $("totalAmWrap").classList.toggle("hidden",!multi);
  if(!multi){
    $("continuousClock").classList.add("hidden");
    $("doubleClock").classList.add("hidden");
    return;
  }
  const withBreak=$("eBreakMode").value==="with";
  $("continuousClock").classList.toggle("hidden",withBreak);
  $("doubleClock").classList.toggle("hidden",!withBreak);
}

document.querySelectorAll("[data-stab]").forEach(btn=>{
  btn.addEventListener("click",()=>{
    document.querySelectorAll("[data-stab]").forEach(x=>x.classList.remove("on"));
    btn.classList.add("on");
    document.querySelectorAll(".staffPanel").forEach(x=>x.classList.add("hidden"));
    $(btn.dataset.stab).classList.remove("hidden");
  });
});

function clockText(){
  if(["DOUBLE","LONG"].includes(eShift)){
    if($("eBreakMode").value==="with"){
      return `${$("eAmIn").value||"--"}–${$("eAmOut").value||"--"} / ${$("ePmIn").value||"--"}–${$("ePmOut").value||"--"}`;
    }
    return `${$("eContIn").value||"--"}–${$("eContOut").value||"--"}`;
  }
  return `${$("eIn").value||"--"}–${$("eOut").value||"--"}`;
}

window.clearEmployeeForm=function(){
  ["eIn","eOut","eContIn","eContOut","eAmIn","eAmOut","ePmIn","ePmOut"].forEach(id=>$(id).value="");
  $("eMeal").value=0;
  $("eCash").value=0;
  $("eGrandTotal").value=0;
  $("eTotalAM").value=0;
};

async function writeAudit(action,submissionId,employee,details={}){
  if(!currentUser || !currentProfile) return;
  const ref=doc(collection(db,"auditLogs"));
  await setDoc(ref,{
    action,
    submissionId:submissionId||"",
    employee:employee||"",
    actorUid:currentUser.uid,
    actor:currentProfile.displayName||currentProfile.username,
    actorRole:currentProfile.role,
    details,
    createdAt:serverTimestamp()
  });
}

window.submitEmployee=async function(){
  const isMulti=["DOUBLE","LONG"].includes(eShift);
  const r={
    employeeUid:currentUser.uid,
    employee:currentProfile.displayName||currentProfile.username,
    date:$("eDate").value,
    position:$("ePosition").value,
    shift:eShift,
    breakMode:isMulti ? $("eBreakMode").value : "none",
    clock:clockText(),
    grandTotal:Number($("eGrandTotal").value)||0,
    totalAM:isMulti ? (Number($("eTotalAM").value)||0) : 0,
    meal:Number($("eMeal").value)||0,
    cashTip:Number($("eCash").value)||0,
    status:"pending",
    reviewedBy:"",
    reviewedAt:null,
    createdAt:serverTimestamp(),
    updatedAt:serverTimestamp()
  };
  if(!r.date){ alert("Select date."); return; }
  try{
    const ref=doc(collection(db,"submissions"));
    await setDoc(ref,r);
    await writeAudit("employee_submit",ref.id,r.employee,{after:r});
    clearEmployeeForm();
    alert("Submitted to Manager.");
  }catch(e){
    console.error(e);
    alert(`Submit failed: ${e.code || e.message}`);
  }
};

function listenEmployee(){
  // Avoid composite-index requirement; sort client-side.
  const q=query(collection(db,"submissions"),where("employeeUid","==",currentUser.uid),limit(50));
  unsubs.push(onSnapshot(q,snap=>{
    const rows=snap.docs.map(d=>({id:d.id,...d.data()}));
    rows.sort((a,b)=>{
      const aa=a.createdAt?.seconds||0, bb=b.createdAt?.seconds||0;
      return bb-aa;
    });
    const a=rows.slice(0,10);
    $("mySubmissions").innerHTML=a.length?a.map(r=>`
      <div style="padding:10px 0;border-bottom:1px solid #edf0f4">
        <b>${esc(r.date)} • ${esc(r.shift)}</b>
        <div class="small">${esc(r.clock)} • Grand $${Number(r.grandTotal||0).toFixed(2)}
        ${["DOUBLE","LONG"].includes(r.shift)?` • AM $${Number(r.totalAM||0).toFixed(2)}`:""}
        • Meal $${Number(r.meal||0).toFixed(2)} • Cash $${Number(r.cashTip||0).toFixed(2)}
        • <span class="status ${esc(r.status)}">${esc(r.status)}</span></div>
      </div>`).join(""):'<div class="small">No submissions yet.</div>';
  },e=>console.error("Employee listener:",e)));
}

function notifyManager(r){
  if(typeof Notification!=="undefined" && Notification.permission==="granted"){
    new Notification("New Employee Submission",{body:`${r.employee} — ${r.shift}`,icon:"icon-192.png"});
  }
}

function listenStaff(){
  const q=query(collection(db,"submissions"),orderBy("createdAt","desc"),limit(500));
  unsubs.push(onSnapshot(q,snap=>{
    const rows=snap.docs.map(d=>({id:d.id,...d.data()}));
    latestRows=rows;
    const pending=rows.filter(r=>r.status==="pending");
    for(const r of pending) if(!knownPending.has(r.id)) notifyManager(r);
    knownPending=new Set(pending.map(r=>r.id));
    renderStaff(rows);
  },e=>{
    console.error("Staff listener:",e);
    $("backendStatus").textContent=`Firestore error: ${e.code || e.message}`;
    $("backendStatus").className="notice danger";
  }));

  if(currentProfile.role==="owner"){
    listenUsers();
    listenHistory();
  }
  $("backendStatus").textContent="FIREBASE / FIRESTORE ONLINE — shared realtime database active.";
  $("backendStatus").className="notice good";
}

function renderStaff(a){
  const p=a.filter(r=>r.status==="pending");
  $("pendingBadge").textContent=p.length;
  $("pendingList").innerHTML=p.length?p.map(r=>`
    <div class="card" style="box-shadow:none">
      <b>${esc(r.employee)} — ${esc(r.shift)}</b>
      <div class="small">${esc(r.date)} • ${esc(r.position)} • ${esc(r.clock)} • ${
        r.breakMode==="with"?"With Break":r.breakMode==="without"?"Without Break":"N/A"
      }</div>
      <div class="small" style="margin:6px 0">Grand $${Number(r.grandTotal||0).toFixed(2)}
        ${["DOUBLE","LONG"].includes(r.shift)?` • Total AM $${Number(r.totalAM||0).toFixed(2)}`:""}
        • Meal $${Number(r.meal||0).toFixed(2)} • Cash Tip $${Number(r.cashTip||0).toFixed(2)}
      </div>
      <div class="actions">
        <button class="btn green" onclick="review('${r.id}','approved')">Approve</button>
        <button class="btn light" onclick="editSubmission('${r.id}')">Edit</button>
        <button class="btn red" onclick="review('${r.id}','rejected')">Reject</button>
        <button class="btn red" onclick="deleteSubmission('${r.id}')">Delete</button>
      </div>
    </div>`).join(""):'<div class="notice good">No pending submissions.</div>';

  const ap=a.filter(r=>r.status!=="pending");
  $("reportBody").innerHTML=ap.length?ap.map(r=>`
    <tr>
      <td>${esc(r.date)}</td><td>${esc(r.employee)}</td><td>${esc(r.position)}</td><td>${esc(r.shift)}</td>
      <td>${r.breakMode==="with"?"With Break":r.breakMode==="without"?"Without Break":"N/A"}</td>
      <td>${esc(r.clock)}</td>
      <td>$${Number(r.grandTotal||0).toFixed(2)}</td>
      <td>${["DOUBLE","LONG"].includes(r.shift)?"$"+Number(r.totalAM||0).toFixed(2):"—"}</td>
      <td>$${Number(r.meal||0).toFixed(2)}</td><td>$${Number(r.cashTip||0).toFixed(2)}</td>
      <td><span class="status ${esc(r.status)}">${esc(r.status)}</span></td>
      <td>${esc(r.reviewedBy||"")}</td>
      <td><div class="actions">
        <button class="btn light" style="padding:6px 8px" onclick="editSubmission('${r.id}')">Edit</button>
        <button class="btn red" style="padding:6px 8px" onclick="deleteSubmission('${r.id}')">Delete</button>
      </div></td>
    </tr>`).join(""):'<tr><td colspan="13">No reviewed records.</td></tr>';
}

window.review=async function(id,status){
  try{
    const ref=doc(db,"submissions",id);
    const beforeSnap=await getDoc(ref);
    const before=beforeSnap.exists()?beforeSnap.data():null;
    await updateDoc(ref,{
      status,
      reviewedBy:currentProfile.displayName||currentProfile.username,
      reviewedAt:serverTimestamp(),
      updatedAt:serverTimestamp()
    });
    await writeAudit(status==="approved"?"approve":"reject",id,before?.employee||"",{before,after:{status}});
  }catch(e){ alert(`Update failed: ${e.code || e.message}`); }
};

function listenUsers(){
  unsubs.push(onSnapshot(collection(db,"users"),snap=>{
    const a=snap.docs.map(d=>({uid:d.id,...d.data()}))
      .sort((a,b)=>(a.username||"").localeCompare(b.username||""));
    $("userList").innerHTML=a.map(u=>`
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #edf0f4;padding:9px 0">
        <div><b>${esc(u.displayName||u.username)}</b><div class="small">${esc(u.role)} • ${esc(u.username)}</div></div>
        ${u.role==="owner"?"":`<button class="btn red" style="padding:7px 10px" onclick="disableUser('${u.uid}')">Disable</button>`}
      </div>`).join("");
  },e=>console.error("Users listener:",e)));
}

window.createUserByOwner=async function(){
  if(currentProfile.role!=="owner") return;
  const username=$("uName").value.trim();
  const role=$("uRole").value;
  const enteredSecret=$("uPass").value.trim();
  if(!username || !enteredSecret){ alert("Username and PIN/password required."); return; }

  let secondaryApp=null;
  try{
    const authPassword = role==="employee" ? employeeAuthPassword(enteredSecret) : enteredSecret;
    secondaryApp=initializeApp(FIREBASE_CONFIG,"create-user-"+Date.now());
    const secondaryAuth=getAuth(secondaryApp);
    const cred=await createUserWithEmailAndPassword(secondaryAuth,emailFor(username),authPassword);
    await setDoc(doc(db,"users",cred.user.uid),{
      username:username.toLowerCase(),
      displayName:username,
      role,
      active:true,
      createdAt:serverTimestamp(),
      createdBy:currentUser.uid
    });
    await writeAudit("user_create",cred.user.uid,username,{role});
    await signOut(secondaryAuth);
    $("uName").value=""; $("uPass").value="";
    alert(`Created ${role}: ${username}`);
  }catch(e){
    console.error("Create user:",e);
    alert(`Create user failed: ${e.code || e.message}`);
  }finally{
    if(secondaryApp) try{await deleteApp(secondaryApp)}catch(e){}
  }
};

window.disableUser=async function(uid){
  if(currentProfile.role!=="owner") return;
  if(!confirm("Disable this user?")) return;
  try{
    const ref=doc(db,"users",uid);
    const s=await getDoc(ref);
    const before=s.exists()?s.data():null;
    await updateDoc(ref,{active:false});
    await writeAudit("user_disable",uid,before?.displayName||before?.username||"",{before});
  }catch(e){ alert(`Disable failed: ${e.code || e.message}`); }
};

window.openAddSubmission=function(){
  $("mId").value="";
  $("editTitle").textContent="Add Submission";
  $("mEmployee").value="";
  $("mDate").value=todayLocal();
  $("mPosition").value="Server";
  $("mShift").value="AM";
  $("mBreakMode").value="none";
  $("mClock").value="";
  $("mGrandTotal").value=0;
  $("mTotalAM").value=0;
  $("mMeal").value=0;
  $("mCash").value=0;
  $("editModal").classList.remove("hidden");
};
window.closeEditModal=function(){ $("editModal").classList.add("hidden"); };

window.editSubmission=function(id){
  const r=latestRows.find(x=>x.id===id);
  if(!r) return;
  $("mId").value=id;
  $("editTitle").textContent="Edit Submission";
  $("mEmployee").value=r.employee||"";
  $("mDate").value=r.date||todayLocal();
  $("mPosition").value=r.position||"Server";
  $("mShift").value=r.shift||"AM";
  $("mBreakMode").value=r.breakMode||"none";
  $("mClock").value=r.clock||"";
  $("mGrandTotal").value=r.grandTotal||0;
  $("mTotalAM").value=r.totalAM||0;
  $("mMeal").value=r.meal||0;
  $("mCash").value=r.cashTip||0;
  $("editModal").classList.remove("hidden");
};

window.saveStaffSubmission=async function(){
  if(!["manager","owner"].includes(currentProfile.role)) return;
  const id=$("mId").value.trim();
  const payload={
    employee:$("mEmployee").value.trim(),
    employeeUid:"",
    date:$("mDate").value,
    position:$("mPosition").value,
    shift:$("mShift").value,
    breakMode:$("mBreakMode").value,
    clock:$("mClock").value.trim(),
    grandTotal:Number($("mGrandTotal").value)||0,
    totalAM:Number($("mTotalAM").value)||0,
    meal:Number($("mMeal").value)||0,
    cashTip:Number($("mCash").value)||0,
    updatedAt:serverTimestamp()
  };
  if(!payload.employee || !payload.date){ alert("Employee and date required."); return; }

  try{
    if(id){
      const ref=doc(db,"submissions",id);
      const s=await getDoc(ref);
      const before=s.exists()?s.data():null;
      await updateDoc(ref,payload);
      await writeAudit("edit",id,payload.employee,{before,after:payload});
    }else{
      const ref=doc(collection(db,"submissions"));
      const full={...payload,status:"approved",reviewedBy:currentProfile.displayName||currentProfile.username,reviewedAt:serverTimestamp(),createdAt:serverTimestamp()};
      await setDoc(ref,full);
      await writeAudit("manager_add",ref.id,payload.employee,{after:full});
    }
    closeEditModal();
  }catch(e){ alert(`Save failed: ${e.code || e.message}`); }
};

window.deleteSubmission=async function(id){
  if(!["manager","owner"].includes(currentProfile.role)) return;
  if(!confirm("Delete this submission?")) return;
  try{
    const ref=doc(db,"submissions",id);
    const s=await getDoc(ref);
    const before=s.exists()?s.data():null;
    await deleteDoc(ref);
    await writeAudit("delete",id,before?.employee||"",{before});
  }catch(e){ alert(`Delete failed: ${e.code || e.message}`); }
};

function listenHistory(){
  if(currentProfile.role!=="owner") return;
  const q=query(collection(db,"auditLogs"),orderBy("createdAt","desc"),limit(500));
  unsubs.push(onSnapshot(q,snap=>{
    const rows=snap.docs.map(d=>({id:d.id,...d.data()}));
    $("historyBody").innerHTML=rows.length?rows.map(r=>{
      let time="";
      try{ time=r.createdAt?.toDate ? r.createdAt.toDate().toLocaleString() : ""; }catch(e){}
      return `<tr>
        <td>${esc(time)}</td><td>${esc(r.actor||"")}</td><td>${esc(r.actorRole||"")}</td>
        <td>${esc(r.action||"")}</td><td>${esc(r.employee||"")}</td>
        <td>${esc(r.submissionId||"")}</td>
        <td>${esc(JSON.stringify(r.details||{}).slice(0,300))}</td>
      </tr>`;
    }).join(""):'<tr><td colspan="7">No history yet.</td></tr>';
  },e=>console.error("History listener:",e)));
}

window.requestNotify=async function(){
  if(!("Notification" in window)){ alert("Notifications not supported here."); return; }
  const p=await Notification.requestPermission();
  alert("Notification permission: "+p);
};

window.exportCSV=function(){
  const rows=[
    ["Date","Employee","Position","Shift","Break","Clock","Grand Total","Total AM","Meal","Cash Tip","Status","Reviewed By"],
    ...latestRows.map(r=>[
      r.date,r.employee,r.position,r.shift,r.breakMode||"none",r.clock,
      r.grandTotal||0,r.totalAM||0,r.meal||0,r.cashTip||0,r.status,r.reviewedBy||""
    ])
  ];
  const csv=rows.map(row=>row.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",")).join("\n");
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  const a=document.createElement("a");
  a.href=url; a.download="Juicy_Tip_Report.csv"; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};

$("eDate").value=todayLocal();
refreshClockMode();
