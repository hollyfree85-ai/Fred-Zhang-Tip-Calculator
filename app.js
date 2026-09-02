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
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { FIREBASE_CONFIG } from "./firebase-config.js";

const firebaseApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const functions = getFunctions(firebaseApp, "us-central1");
const createUserAdmin = httpsCallable(functions, "createAppUser");
const deleteUserAdmin = httpsCallable(functions, "deleteAppUser");

let currentUser = null;
let currentProfile = null;
let eShift = "AM";
let unsubs = [];
let latestRows = [];
let knownPending = new Set();
let lastHourlyResult = null;
let currentHourlySubmissionId = null;
let currentHourlyReportId = null;
let latestHourlyReports = [];
let userNameByUid = {};
const EMPLOYEE_ROSTER = Object.freeze(["Adrieanna Walker", "Aida Gonzales", "Alainna Montalvo", "Angela Grizzad", "Ariana Garner", "Ashley Garcia", "Brandi Copeland", "Caitlin Dillon", "Christina Gurley", "Dorothy Makovicka", "Fred Zhang", "Hannah Dempsey", "Jesus Ovalle-Munoz", "Libby Lane", "Megan Meadows", "Megan Sisk", "Mia Burress", "Sara Swift", "Sarah Kibler"]);


const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[m]));

function todayLocal(){
  const d=new Date(), z=n=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`;
}
function slugFor(username){
  return String(username).trim().toLowerCase().replace(/[^a-z0-9._-]/g,"");
}
function emailFor(username){
  return `${slugFor(username)}@juicytip.app`;
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


function populateRoster(){
  const options=EMPLOYEE_ROSTER.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join("");
  ["employeeUsername","signupName","hEmployee"].forEach(id=>{
    const el=$(id); if(el) el.innerHTML=options;
  });
}
window.toggleSignup=function(show){
  $("signupPanel").classList.toggle("hidden",!show);
  loginMsg("");
};

window.employeeSignup=async function(){
  const name=$("signupName").value;
  const phone=$("signupPhone").value.trim();
  const pin=$("signupPin").value.trim();
  const pin2=$("signupPin2").value.trim();

  if(!EMPLOYEE_ROSTER.includes(name)){ alert("Select your name from the employee list."); return; }
  const phoneDigits=phone.replace(/\D/g,"");
  if(!/^\d{7,15}$/.test(phoneDigits)){ alert("Enter a valid mobile phone number."); return; }
  if(!/^\d{4}$/.test(pin)){ alert("PIN must be exactly 4 digits."); return; }
  if(pin!==pin2){ alert("PINs do not match."); return; }

  let secondaryApp=null;
  try{
    secondaryApp=initializeApp(FIREBASE_CONFIG,"employee-signup-"+Date.now());
    const secondaryAuth=getAuth(secondaryApp);
    const secondaryDb=getFirestore(secondaryApp);
    const email=emailFor(name);
    const authPassword=employeeAuthPassword(pin);

    let cred;
    try{
      cred=await createUserWithEmailAndPassword(secondaryAuth,email,authPassword);
    }catch(createErr){
      if(createErr.code==="auth/email-already-in-use"){
        cred=await signInWithEmailAndPassword(secondaryAuth,email,authPassword);
      }else{
        throw createErr;
      }
    }

    const uid=cred.user.uid;
    const profile={
      username:slugFor(name),
      displayName:name,
      phone:phoneDigits,
      role:"employee",
      active:false,
      approvalStatus:"pending",
      createdAt:serverTimestamp()
    };

    await setDoc(doc(secondaryDb,"users",uid),profile);
    await setDoc(doc(secondaryDb,"signupRequests",uid),{
      uid,
      displayName:name,
      username:slugFor(name),
      phone:phoneDigits,
      status:"pending",
      requestedAt:serverTimestamp()
    });

    await signOut(secondaryAuth);
    toggleSignup(false);
    $("signupPhone").value="";
    $("signupPin").value="";
    $("signupPin2").value="";
    alert("Sign up sent. Please wait for Manager approval.");
  }catch(e){
    console.error("Employee signup:",e);
    let msg=`Sign up failed: ${e.code || e.message}`;
    if(e.code==="auth/wrong-password" || e.code==="auth/invalid-credential"){
      msg="This employee account already exists with a different PIN. Ask Manager/Owner to remove or reset the old account.";
    }
    alert(msg);
  }finally{
    if(secondaryApp) try{await deleteApp(secondaryApp)}catch(e){}
  }
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
    if(profile.role==="employee" && profile.approvalStatus==="pending"){
      loginMsg("Registration is waiting for Manager approval.");
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


function updateEmployeeBusserPreview(){
  const box=$("employeeBusserPreview"), out=$("eBusserRate");
  if(!box||!out) return;
  const multi=["DOUBLE","LONG"].includes(eShift);
  box.classList.toggle("hidden",!multi);
  if(!multi){ out.textContent="0.00%"; return; }
  const grand=Number($("eGrandTotal").value)||0;
  const am=Number($("eTotalAM").value)||0;
  if(grand<=0){ out.textContent="0.00%"; return; }
  const safeAM=Math.max(0,Math.min(am,grand));
  // Existing V01 Double/Long effective busser formula (without AM busser):
  // PM tip-out = (Grand Total - Total AM) × 1.5%; displayed rate = tip-out / Grand Total.
  const rate=((grand-safeAM)*0.015/grand)*100;
  out.textContent=rate.toFixed(2)+"%";
}
$("eGrandTotal").addEventListener("input",updateEmployeeBusserPreview);
$("eTotalAM").addEventListener("input",updateEmployeeBusserPreview);

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
  updateEmployeeBusserPreview();
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
  $("ePaidTip").value=0;
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
    paidTip:Number($("ePaidTip").value)||0,
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
        • Paid Tip $${Number(r.paidTip||0).toFixed(2)} • Meal $${Number(r.meal||0).toFixed(2)} • Cash $${Number(r.cashTip||0).toFixed(2)}
        • <span class="status ${esc(r.status)}">${esc(r.status)}</span></div>
        ${r.status==="money_ready"?'<div class="notice good" style="margin-top:8px"><b>Money is ready. Please come to cashier.</b></div>':""}
      </div>`).join(""):'<div class="small">No submissions yet.</div>';

    const ready=a.find(r=>r.status==="money_ready" && !sessionStorage.getItem("moneyReady:"+r.id));
    if(ready){
      sessionStorage.setItem("moneyReady:"+ready.id,"1");
      if(typeof Notification!=="undefined" && Notification.permission==="granted"){
        new Notification("Fred Zhang Tip Calculator",{body:"Money is ready. Please come to cashier.",icon:"icon-192.png"});
      }
    }
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

  listenApprovals();
  listenHourlyReports();
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
        • Paid Tip $${Number(r.paidTip||0).toFixed(2)} • Meal $${Number(r.meal||0).toFixed(2)} • Cash Tip $${Number(r.cashTip||0).toFixed(2)}
      </div>
      <div class="actions">
        <button class="btn green" onclick="review('${r.id}','approved')">Review / Approve</button>
        <button class="btn light" onclick="editSubmission('${r.id}')">Edit</button>
        <button class="btn red" onclick="review('${r.id}','rejected')">Reject</button>
        <button class="btn red" onclick="deleteSubmission('${r.id}')">Delete</button>
      </div>
    </div>`).join(""):'<div class="notice good">No pending submissions.</div>';

  const ap=a;
  $("reportBody").innerHTML=ap.length?ap.map(r=>`
    <tr>
      <td>${esc(r.date)}</td><td>${esc(r.employee)}</td><td>${esc(r.position)}</td><td>${esc(r.shift)}</td>
      <td>${r.breakMode==="with"?"With Break":r.breakMode==="without"?"Without Break":"N/A"}</td>
      <td>${esc(r.clock)}</td>
      <td>$${Number(r.grandTotal||0).toFixed(2)}</td>
      <td>${["DOUBLE","LONG"].includes(r.shift)?"$"+Number(r.totalAM||0).toFixed(2):"—"}</td>
      <td>$${Number(r.paidTip||0).toFixed(2)}</td>
      <td>$${Number(r.meal||0).toFixed(2)}</td><td>$${Number(r.cashTip||0).toFixed(2)}</td>
      <td><span class="status ${esc(r.status)}">${esc(r.status)}</span></td>
      <td>${esc(r.reviewedBy||"")}</td>
      <td><div class="actions">
        <button class="btn light" style="padding:6px 8px" onclick="editSubmission('${r.id}')">${r.status==="pending"?"Review / Edit":"Edit"}</button>
        <button class="btn red" style="padding:6px 8px" onclick="deleteSubmission('${r.id}')">Delete</button>
      </div></td>
    </tr>`).join(""):'<tr><td colspan="13">No reviewed records.</td></tr>';

  renderHourlyQueue(a);
}

window.review=async function(id,status){
  if(status==="approved"){
    document.querySelector('[data-stab="report"]')?.click();
    setTimeout(()=>editSubmission(id),100);
    return;
  }
  try{
    const ref=doc(db,"submissions",id);
    const beforeSnap=await getDoc(ref);
    const before=beforeSnap.exists()?beforeSnap.data():null;
    await updateDoc(ref,{
      status:"rejected",
      reviewedBy:currentProfile.displayName||currentProfile.username,
      reviewedAt:serverTimestamp(),
      updatedAt:serverTimestamp()
    });
    await writeAudit("reject",id,before?.employee||"",{before,after:{status:"rejected"}});
  }catch(e){ alert(`Update failed: ${e.code || e.message}`); }
};


function listenApprovals(){
  const q=query(collection(db,"signupRequests"),where("status","==","pending"),limit(100));
  unsubs.push(onSnapshot(q,snap=>{
    const rows=snap.docs.map(d=>({id:d.id,...d.data()}));
    $("approvalBadge").textContent=rows.length;
    $("approvalList").innerHTML=rows.length?rows.map(r=>`
      <div class="approval-card">
        <b>${esc(r.displayName)}</b>
        <div class="small">Phone: ${esc(r.phone||"")} • Username: ${esc(r.username||"")}</div>
        <div class="actions" style="margin-top:10px">
          <button class="btn green" onclick="approveEmployee('${r.uid}')">Approve</button>
          <button class="btn red" onclick="rejectEmployee('${r.uid}')">Reject</button>
        </div>
      </div>`).join(""):'<div class="notice good">No pending employee sign ups.</div>';
  },e=>console.error("Approvals listener:",e)));
}

window.approveEmployee=async function(uid){
  if(!["manager","owner"].includes(currentProfile.role)) return;
  try{
    const uref=doc(db,"users",uid), rref=doc(db,"signupRequests",uid);
    const us=await getDoc(uref);
    if(!us.exists()){ alert("Employee profile not found."); return; }
    const before=us.data();
    await updateDoc(uref,{
      active:true,
      approvalStatus:"approved",
      approvedBy:currentProfile.displayName||currentProfile.username,
      approvedAt:serverTimestamp()
    });
    await updateDoc(rref,{
      status:"approved",
      reviewedBy:currentProfile.displayName||currentProfile.username,
      reviewedAt:serverTimestamp()
    });
    await writeAudit("employee_signup_approved",uid,before.displayName||"",{before,after:{active:true,approvalStatus:"approved"}});
  }catch(e){ alert(`Approve failed: ${e.code || e.message}`); }
};

window.rejectEmployee=async function(uid){
  if(!["manager","owner"].includes(currentProfile.role)) return;
  if(!confirm("Reject this employee sign up?")) return;
  try{
    const uref=doc(db,"users",uid), rref=doc(db,"signupRequests",uid);
    const us=await getDoc(uref);
    const before=us.exists()?us.data():null;
    if(us.exists()) await updateDoc(uref,{active:false,approvalStatus:"rejected"});
    await updateDoc(rref,{
      status:"rejected",
      reviewedBy:currentProfile.displayName||currentProfile.username,
      reviewedAt:serverTimestamp()
    });
    await writeAudit("employee_signup_rejected",uid,before?.displayName||"",{before});
  }catch(e){ alert(`Reject failed: ${e.code || e.message}`); }
};

function listenUsers(){
  unsubs.push(onSnapshot(collection(db,"users"),snap=>{
    const a=snap.docs.map(d=>({uid:d.id,...d.data()}))
      .sort((a,b)=>(a.username||"").localeCompare(b.username||""));
    userNameByUid=Object.fromEntries(a.map(u=>[u.uid,u.displayName||u.username||""]));
    $("userList").innerHTML=a.map(u=>{
      const active = u.active !== false;
      const status = active
        ? '<span class="status approved">ACTIVE</span>'
        : '<span class="status rejected">DISABLED</span>';
      const action = u.role==="owner" ? "" : `
        <div class="actions" style="justify-content:flex-end">
          ${active
            ? `<button class="btn red" style="padding:7px 10px" onclick="setUserActive('${u.uid}',false)">Disable</button>`
            : `<button class="btn green" style="padding:7px 10px" onclick="setUserActive('${u.uid}',true)">Enable</button>`}
          <button class="btn red" style="padding:7px 10px;background:#7f1d1d;color:white" onclick="deleteAppUser(\'${u.uid}\')">Delete</button>
        </div>`;
      return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px solid #edf0f4;padding:9px 0">
        <div>
          <b>${esc(u.displayName||u.username)}</b>
          <div class="small">${esc(u.role)} • ${esc(u.username)} • ${status}</div>
        </div>
        ${action}
      </div>`;
    }).join("");
  },e=>console.error("Users listener:",e)));
}


window.deleteAppUser=async function(uid){
  if(currentProfile.role!=="owner") return;
  const username=userNameByUid[uid]||"this user";
  if(!confirm(`DELETE ${username} completely?\n\nThis removes Firebase Authentication + app profile + signup request. This cannot be undone.`)) return;
  try{
    const result=await deleteUserAdmin({uid});
    if(result?.data?.ok){
      alert("User deleted completely.");
    }else{
      alert("Delete request completed.");
    }
  }catch(e){
    console.error("Admin delete user:",e);
    alert(`Delete failed: ${e.message || e.code || "unknown error"}`);
  }
};

window.createUserByOwner=async function(){
  if(currentProfile.role!=="owner") return;
  const username=$("uName").value.trim();
  const role=$("uRole").value;
  const secret=$("uPass").value.trim();

  if(!username || !secret){
    alert("Username and PIN/password required.");
    return;
  }
  if(role==="employee" && !/^\d{4}$/.test(secret)){
    alert("Employee PIN must be exactly 4 digits.");
    return;
  }
  if(role==="manager" && secret.length<6){
    alert("Manager password must be at least 6 characters.");
    return;
  }

  try{
    const result=await createUserAdmin({username,role,secret});
    $("uName").value="";
    $("uPass").value="";
    alert(`Created ${role}: ${result.data.displayName}`);
  }catch(e){
    console.error("Admin create user:",e);
    alert(`Create user failed: ${e.message || e.code || "unknown error"}`);
  }
};

window.setUserActive=async function(uid,active){
  if(currentProfile.role!=="owner") return;
  const verb = active ? "enable" : "disable";
  if(!confirm(`${verb.charAt(0).toUpperCase()+verb.slice(1)} this user?`)) return;
  try{
    const ref=doc(db,"users",uid);
    const s=await getDoc(ref);
    if(!s.exists()){ alert("User profile not found."); return; }
    const before=s.data();
    await updateDoc(ref,{active:!!active});
    try{
      await writeAudit(active ? "user_enable" : "user_disable",uid,before?.displayName||before?.username||"",{
        before,
        after:{active:!!active}
      });
    }catch(auditErr){
      console.warn("Status changed, audit log failed:",auditErr);
    }
    alert(`User ${active ? "enabled" : "disabled"} successfully.`);
  }catch(e){
    console.error("User status:",e);
    alert(`User status failed: ${e.code || e.message}`);
  }
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
  $("mPaidTip").value=0;
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
  $("mPaidTip").value=r.paidTip||0;
  $("mMeal").value=r.meal||0;
  $("mCash").value=r.cashTip||0;
  $("editModal").classList.remove("hidden");
};

window.saveStaffSubmission=async function(){
  if(!["manager","owner"].includes(currentProfile.role)) return;
  const id=$("mId").value.trim();
  const payload={
    employee:$("mEmployee").value.trim(),
    date:$("mDate").value,
    position:$("mPosition").value,
    shift:$("mShift").value,
    breakMode:$("mBreakMode").value,
    clock:$("mClock").value.trim(),
    grandTotal:Number($("mGrandTotal").value)||0,
    totalAM:Number($("mTotalAM").value)||0,
    paidTip:Number($("mPaidTip").value)||0,
    meal:Number($("mMeal").value)||0,
    cashTip:Number($("mCash").value)||0,
    status:"hourly_pending",
    hourlyStatus:"waiting_manager",
    reviewedBy:currentProfile.displayName||currentProfile.username,
    reviewedAt:serverTimestamp(),
    updatedAt:serverTimestamp()
  };
  if(!payload.employee || !payload.date){ alert("Employee and date required."); return; }

  try{
    let targetId=id;
    if(id){
      const ref=doc(db,"submissions",id);
      const s=await getDoc(ref);
      const before=s.exists()?s.data():null;
      // Preserve employeeUid from original record by updating only manager-review fields.
      await updateDoc(ref,payload);
      await writeAudit("manager_review_to_hourly",id,payload.employee,{before,after:payload});
    }else{
      const ref=doc(collection(db,"submissions"));
      targetId=ref.id;
      const full={...payload,employeeUid:"",createdAt:serverTimestamp()};
      await setDoc(ref,full);
      await writeAudit("manager_add_to_hourly",ref.id,payload.employee,{after:full});
    }
    closeEditModal();
    setTimeout(()=>{
      document.querySelector('[data-stab="hourly"]')?.click();
      setTimeout(()=>window.loadSubmissionToHourly?.(targetId),150);
    },100);
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



function parseClockParts(r){
  const text=String(r.clock||"").replaceAll("–","-");
  const pairs=text.split("/").map(s=>s.trim());
  if(pairs.length>1){
    const a=pairs[0].split("-").map(s=>s.trim());
    const p=pairs[1].split("-").map(s=>s.trim());
    return {amIn:a[0]||"",amOut:a[1]||"",pmIn:p[0]||"",pmOut:p[1]||""};
  }
  const one=pairs[0].split("-").map(s=>s.trim());
  return {in:one[0]||"",out:one[1]||""};
}

function renderHourlyQueue(rows){
  const el=$("hourlyQueue"); if(!el) return;
  const q=rows.filter(r=>["hourly_pending","approved"].includes(r.status));
  el.innerHTML=q.length?q.map(r=>`
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px solid #edf0f4;padding:10px 0">
      <div>
        <b>${esc(r.employee)} — ${esc(r.shift)}</b>
        <div class="small">${esc(r.date)} • ${esc(r.clock)} • Grand $${Number(r.grandTotal||0).toFixed(2)} • Paid Tip $${Number(r.paidTip||0).toFixed(2)} • Meal $${Number(r.meal||0).toFixed(2)} • Cash $${Number(r.cashTip||0).toFixed(2)}</div>
      </div>
      <button class="btn green" onclick="loadSubmissionToHourly('${r.id}')">Open in Hourly</button>
    </div>`).join(""):'<div class="notice good">No approved employee data waiting.</div>';
}

window.loadSubmissionToHourly=function(id){
  const r=latestRows.find(x=>x.id===id);
  if(!r) return;
  currentHourlySubmissionId=id;
  currentHourlyReportId=null;
  $("hDate").value=r.date||todayLocal();
  $("hEmployee").value=r.employee||"";
  $("hPosition").value=r.position||"Server";
  $("hShift").value=(r.shift==="LONG"?"DOUBLE":r.shift||"AM");
  $("hMeal").value=Number(r.meal||0);
  $("hGrandTotal").value=Number(r.grandTotal||0);
  $("hTotalAM").value=Number(r.totalAM||0);
  $("hCashTip").value=Number(r.cashTip||0);
  $("hPaidTip").value=Number(r.paidTip||0);
  $("hCardFee").value=0;
  syncHourlyShift();
  const c=parseClockParts(r);
  if($("hShift").value==="DOUBLE"){
    $("hAmIn").value=c.amIn||c.in||"";
    $("hAmOut").value=c.amOut||"";
    $("hPmIn").value=c.pmIn||"";
    $("hPmOut").value=c.pmOut||c.out||"";
  }else{
    $("hIn").value=c.in||"";
    $("hOut").value=c.out||"";
  }
  $("hourlyResult").classList.add("hidden");
  window.scrollTo({top:$("hourly").offsetTop-10,behavior:"smooth"});
};

function listenHourlyReports(){
  const q=query(collection(db,"hourlyReports"),orderBy("createdAt","desc"),limit(200));
  unsubs.push(onSnapshot(q,snap=>{
    latestHourlyReports=snap.docs.map(d=>({id:d.id,...d.data()}));
    const el=$("hourlyReportsList"); if(!el) return;
    el.innerHTML=latestHourlyReports.length?latestHourlyReports.map(r=>`
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px solid #edf0f4;padding:10px 0">
        <div>
          <b>${esc(r.date||"")} • ${esc(r.employee||"")} • ${esc(r.shift||"")}</b>
          <div class="small">Paid Out $${Number(r.totalPaidOut||0).toFixed(2)} • <span class="status approved">money_ready</span></div>
        </div>
        <div class="actions">
          <button class="btn light" onclick="editHourlyReport('${r.id}')">Edit</button>
          <button class="btn red" onclick="deleteHourlyReport('${r.id}')">Delete</button>
        </div>
      </div>`).join(""):'<div class="small">No final reports yet.</div>';
  },e=>console.error("Hourly reports:",e)));
}

window.editHourlyReport=function(id){
  const r=latestHourlyReports.find(x=>x.id===id); if(!r) return;
  currentHourlyReportId=id;
  currentHourlySubmissionId=r.sourceSubmissionId||null;
  $("hDate").value=r.date||todayLocal();
  $("hEmployee").value=r.employee||"";
  $("hPosition").value=r.position||"Server";
  $("hShift").value=r.shift||"AM";
  $("hBusserAM").value=r.busserAM||"WITH";
  $("hMeal").value=Number(r.meal||0);
  $("hGrandTotal").value=Number(r.grandTotal||0);
  $("hTotalAM").value=Number(r.totalAM||0);
  $("hPaidTip").value=Number(r.paidTip||0);
  $("hCardFee").value=Number(r.cardFee||0);
  $("hCashTip").value=Number(r.cashTip||0);
  $("hAmBar").value=r.amBarSales?"yes":"no";
  $("hPmBar").value=r.pmBarSales?"yes":"no";
  syncHourlyShift();
  const hrs=r.hours||{};
  $("hIn").value=hrs.hourIn||"";
  $("hOut").value=hrs.hourOut||"";
  $("hAmIn").value=hrs.hourInAM||"";
  $("hAmOut").value=hrs.hourOutAM||"";
  $("hPmIn").value=hrs.hourInPM||"";
  $("hPmOut").value=hrs.hourOutPM||"";
  document.querySelector('[data-stab="hourly"]')?.click();
};

window.deleteHourlyReport=async function(id){
  if(!["manager","owner"].includes(currentProfile.role)) return;
  if(!confirm("Delete this final hourly report?")) return;
  try{
    const ref=doc(db,"hourlyReports",id);
    const s=await getDoc(ref);
    const before=s.exists()?s.data():null;
    await deleteDoc(ref);
    if(before?.sourceSubmissionId){
      await updateDoc(doc(db,"submissions",before.sourceSubmissionId),{
        status:"hourly_pending",
        hourlyStatus:"waiting_manager",
        hourlyReportId:"",
        updatedAt:serverTimestamp()
      });
    }
    await writeAudit("hourly_report_delete",id,before?.employee||"",{before});
  }catch(e){ alert(`Delete report failed: ${e.code||e.message}`); }
};

function syncHourlyShift(){
  const dbl=$("hShift").value==="DOUBLE";
  $("hSingleClock").classList.toggle("hidden",dbl);
  $("hDoubleClock").classList.toggle("hidden",!dbl);
  $("hTotalAMWrap").classList.toggle("hidden",!dbl);
}
$("hShift").addEventListener("change",syncHourlyShift);

window.calculateHourlyV01=function(){
  const L=window.FredTipCalculatorLogic;
  if(!L){ alert("Hourly Adjustment V01 calculation engine is unavailable."); return null; }
  const shift=$("hShift").value;
  const hours=shift==="DOUBLE" ? {
    hourInAM:$("hAmIn").value,
    hourOutAM:$("hAmOut").value,
    hourInPM:$("hPmIn").value,
    hourOutPM:$("hPmOut").value
  } : {
    hourIn:$("hIn").value,
    hourOut:$("hOut").value
  };
  lastHourlyResult=L.calculateReport({
    date:$("hDate").value,
    employee:$("hEmployee").value,
    position:$("hPosition").value,
    shift,
    busserAM:$("hBusserAM").value,
    hours,
    grandTotal:$("hGrandTotal").value,
    totalAM:$("hTotalAM").value,
    paidTip:$("hPaidTip").value,
    cardFee:$("hCardFee").value,
    cashTip:$("hCashTip").value,
    meal:$("hMeal").value,
    amBarSales:$("hAmBar").value==="yes",
    pmBarSales:$("hPmBar").value==="yes"
  });
  const r=lastHourlyResult;
  $("hrHours").textContent=r.totalHoursWork==null?"—":Number(r.totalHoursWork).toFixed(2);
  $("hrMinimum").textContent="$"+Number(r.hourlyMinimum||0).toFixed(2);
  $("hrAdjustment").textContent="$"+Number(r.adjustmentSalaryHourly||0).toFixed(2);
  $("hrGrandTip").textContent="$"+Number(r.grandTotalTip||0).toFixed(2);
  $("hrAfter").textContent="$"+Number(r.grandTotalAfterAdjustment||0).toFixed(2);
  $("hrPaidOut").textContent="$"+Number(r.totalPaidOut||0).toFixed(2);
  $("hourlyResult").classList.remove("hidden");
  return r;
};

window.saveHourlyV01=async function(){
  const r=calculateHourlyV01();
  if(!r) return;
  try{
    let ref;
    if(currentHourlyReportId){
      ref=doc(db,"hourlyReports",currentHourlyReportId);
      const old=await getDoc(ref);
      await updateDoc(ref,{
        ...r,
        sourceSubmissionId:currentHourlySubmissionId||"",
        status:"money_ready",
        updatedAt:serverTimestamp(),
        updatedBy:currentProfile.displayName||currentProfile.username
      });
      await writeAudit("hourly_report_edit",currentHourlyReportId,r.employee,{before:old.exists()?old.data():null,after:r});
    }else{
      ref=doc(collection(db,"hourlyReports"));
      await setDoc(ref,{
        ...r,
        sourceSubmissionId:currentHourlySubmissionId||"",
        status:"money_ready",
        createdAt:serverTimestamp(),
        createdByUid:currentUser.uid,
        createdBy:currentProfile.displayName||currentProfile.username
      });
      await writeAudit("hourly_final_money_ready",ref.id,r.employee,{after:r,sourceSubmissionId:currentHourlySubmissionId||""});
    }

    if(currentHourlySubmissionId){
      await updateDoc(doc(db,"submissions",currentHourlySubmissionId),{
        status:"money_ready",
        hourlyStatus:"finalized",
        hourlyReportId:ref.id,
        finalizedBy:currentProfile.displayName||currentProfile.username,
        finalizedAt:serverTimestamp(),
        updatedAt:serverTimestamp()
      });
    }

    alert("Final submitted. Employee message: Money is ready. Please come to cashier.");
    currentHourlyReportId=null;
    currentHourlySubmissionId=null;
  }catch(e){ alert(`Save failed: ${e.code || e.message}`); }
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
$("hDate").value=todayLocal();
populateRoster();
refreshClockMode();
syncHourlyShift();

// V9.2 employee input improvements
function fz24(id){
 const e=document.getElementById(id); if(!e)return;
 e.addEventListener("input",()=>{let d=e.value.replace(/\D/g,"").slice(0,4);e.value=d.length>2?d.slice(0,2)+":"+d.slice(2):d;});
}
["eIn","eOut","eContIn","eContOut","eAmIn","eAmOut","ePmIn","ePmOut"].forEach(fz24);
["eGrandTotal","eTotalAM","ePaidTip","eMeal","eCash"].forEach(id=>{
 const e=document.getElementById(id); if(e)e.addEventListener("focus",()=>{if(Number(e.value)===0)setTimeout(()=>e.select(),0);});
});

// V9.3 workflow: approve -> hourly queue -> final money ready; final report edit/delete; fixed app user delete.

// V9.4: employee Paid Tip field added; Total AM remains conditional for DOUBLE/LONG; formulas unchanged.

// V9.5: employee live busser % for DOUBLE/LONG; Manager Review/Report submit routes same record into Hourly; final save triggers money_ready notification. V01 formulas unchanged.
