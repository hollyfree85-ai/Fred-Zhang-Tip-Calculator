import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, orderBy, limit, onSnapshot, getDocs, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { FIREBASE_CONFIG } from "./firebase-config.js";

const app=initializeApp(FIREBASE_CONFIG);
const auth=getAuth(app), db=getFirestore(app);
let currentUser=null,currentProfile=null,eShift='AM',unsubs=[],latestRows=[],knownPending=new Set();

const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const emailFor=u=>`${String(u).trim().toLowerCase().replace(/[^a-z0-9._-]/g,'')}@juicytip.app`;
function todayLocal(){const d=new Date(),z=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`}

window.setLoginMode=mode=>{$('employeeLogin').classList.toggle('hidden',mode!=='employee');$('staffLogin').classList.toggle('hidden',mode!=='staff');$('employeeModeBtn').classList.toggle('on',mode==='employee');$('staffModeBtn').classList.toggle('on',mode==='staff')};
window.loginEmployee=async()=>{try{loginMsg('Signing in...');await signInWithEmailAndPassword(auth,emailFor($('employeeUsername').value),$('employeePin').value)}catch(e){loginMsg('Invalid employee username or PIN.')}};
window.loginStaff=async()=>{try{loginMsg('Signing in...');await signInWithEmailAndPassword(auth,emailFor($('staffUsername').value),$('staffPassword').value)}catch(e){loginMsg('Invalid username or password.')}};
window.logout=async()=>{await signOut(auth);location.reload()};
function loginMsg(m){$('loginMessage').textContent=m}

async function loadProfile(uid){const s=await getDoc(doc(db,'users',uid));return s.exists()?s.data():null}
function showApp(){
  $('loginView').classList.add('hidden');$('appView').classList.remove('hidden');$('top').classList.remove('hidden');
  $('whoText').textContent=currentProfile.displayName||currentProfile.username;$('rolePill').textContent=currentProfile.role.toUpperCase();
  const emp=currentProfile.role==='employee';$('employeeApp').classList.toggle('hidden',!emp);$('staffApp').classList.toggle('hidden',emp);$('employeeBottom').classList.toggle('hidden',!emp);
  document.querySelectorAll('.ownerOnly').forEach(x=>x.classList.toggle('hidden',currentProfile.role!=='owner'));
  if(emp)listenEmployee();else listenStaff();
}
function hideApp(){$('loginView').classList.remove('hidden');$('appView').classList.add('hidden');$('top').classList.add('hidden')}
function clearListeners(){unsubs.forEach(f=>{try{f()}catch(e){}});unsubs=[]}

onAuthStateChanged(auth,async u=>{
  clearListeners();
  if(!u){currentUser=null;currentProfile=null;hideApp();return}
  currentUser=u;currentProfile=await loadProfile(u.uid);
  if(!currentProfile||currentProfile.active===false){await signOut(auth);loginMsg('This account is not active.');return}
  showApp();
});

document.querySelectorAll('[data-eshift]').forEach(b=>b.onclick=()=>{
  eShift=b.dataset.eshift;
  document.querySelectorAll('[data-eshift]').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');
  refreshClockMode();
});
$('eBreakMode').addEventListener('change',refreshClockMode);
function refreshClockMode(){
  const multi=['DOUBLE','LONG'].includes(eShift);
  $('singleClock').classList.toggle('hidden',multi);
  $('longDoubleOptions').classList.toggle('hidden',!multi);
  $('totalAmWrap').classList.toggle('hidden',!multi);
  if(!multi){
    $('continuousClock').classList.add('hidden');
    $('doubleClock').classList.add('hidden');
    return;
  }
  const withBreak=$('eBreakMode').value==='with';
  $('continuousClock').classList.toggle('hidden',withBreak);
  $('doubleClock').classList.toggle('hidden',!withBreak);
}
document.querySelectorAll('[data-stab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-stab]').forEach(x=>x.classList.remove('on'));b.classList.add('on');document.querySelectorAll('.staffPanel').forEach(x=>x.classList.add('hidden'));$(b.dataset.stab).classList.remove('hidden')});

function clockText(){
  if(['DOUBLE','LONG'].includes(eShift)){
    if($('eBreakMode').value==='with'){
      return `${eAmIn.value||'--'}–${eAmOut.value||'--'} / ${ePmIn.value||'--'}–${ePmOut.value||'--'}`;
    }
    return `${eContIn.value||'--'}–${eContOut.value||'--'}`;
  }
  return `${eIn.value||'--'}–${eOut.value||'--'}`;
}–${eAmOut.value||'--'} / ${ePmIn.value||'--'}–${ePmOut.value||'--'}`;return `${eIn.value||'--'}–${eOut.value||'--'}`}
window.clearEmployeeForm=()=>{
  ['eIn','eOut','eContIn','eContOut','eAmIn','eAmOut','ePmIn','ePmOut'].forEach(id=>$(id).value='');
  eMeal.value=0;eCash.value=0;eGrandTotal.value=0;eTotalAM.value=0;
};
window.submitEmployee=async()=>{
  const isMulti=['DOUBLE','LONG'].includes(eShift);
  const r={
    employeeUid:currentUser.uid,
    employee:currentProfile.displayName||currentProfile.username,
    date:eDate.value,
    position:ePosition.value,
    shift:eShift,
    breakMode:isMulti?eBreakMode.value:'none',
    clock:clockText(),
    grandTotal:Number(eGrandTotal.value)||0,
    totalAM:isMulti?(Number(eTotalAM.value)||0):0,
    meal:Number(eMeal.value)||0,
    cashTip:Number(eCash.value)||0,
    status:'pending',
    reviewedBy:'',
    reviewedAt:null,
    createdAt:serverTimestamp(),
    updatedAt:serverTimestamp()
  };
  if(!r.date)return alert('Select date.');
  const ref=doc(collection(db,'submissions'));
  await setDoc(ref,r);
  await writeAudit('employee_submit',ref.id,r.employee,{after:r});
  clearEmployeeForm();
  alert('Submitted to Manager.');
};

function listenEmployee(){
  const q=query(collection(db,'submissions'),where('employeeUid','==',currentUser.uid),orderBy('createdAt','desc'),limit(10));
  unsubs.push(onSnapshot(q,snap=>{
    const a=snap.docs.map(d=>({id:d.id,...d.data()}));
    mySubmissions.innerHTML=a.length?a.map(r=>`<div style="padding:10px 0;border-bottom:1px solid #edf0f4"><b>${esc(r.date)} • ${esc(r.shift)}</b><div class="small">${esc(r.clock)} • Grand $${(+(r.grandTotal||0)).toFixed(2)}${['DOUBLE','LONG'].includes(r.shift)?` • AM $${(+(r.totalAM||0)).toFixed(2)}`:''} • Meal $${(+r.meal).toFixed(2)} • Cash $${(+r.cashTip).toFixed(2)} • <span class="status ${r.status}">${esc(r.status)}</span></div></div>`).join(''):'<div class="small">No submissions yet.</div>';
  }));
}
function listenStaff(){
  const q=query(collection(db,'submissions'),orderBy('createdAt','desc'),limit(500));
  unsubs.push(onSnapshot(q,snap=>{
    const rows=snap.docs.map(d=>({id:d.id,...d.data()}));latestRows=rows;
    const pending=rows.filter(r=>r.status==='pending');
    for(const r of pending){if(!knownPending.has(r.id))notifyManager(r)}
    knownPending=new Set(pending.map(r=>r.id));renderStaff(rows);
  }));
  if(currentProfile.role==='owner'){listenUsers();listenHistory();}
  backendStatus.textContent='FIREBASE / FIRESTORE ONLINE — shared realtime database active for all phones.';
  backendStatus.className='notice good';
}
function renderStaff(a){
  const p=a.filter(r=>r.status==='pending');
  pendingBadge.textContent=p.length;
  pendingList.innerHTML=p.length?p.map(r=>`<div class="card" style="box-shadow:none">
    <b>${esc(r.employee)} — ${esc(r.shift)}</b>
    <div class="small">${esc(r.date)} • ${esc(r.position)} • ${esc(r.clock)} • ${r.breakMode==='with'?'With Break':r.breakMode==='without'?'Without Break':'N/A'}</div>
    <div class="small" style="margin:6px 0">Grand $${(+(r.grandTotal||0)).toFixed(2)}${['DOUBLE','LONG'].includes(r.shift)?` • Total AM $${(+(r.totalAM||0)).toFixed(2)}`:''} • Meal $${(+r.meal).toFixed(2)} • Cash Tip $${(+r.cashTip).toFixed(2)}</div>
    <div class="actions">
      <button class="btn green" onclick="review('${r.id}','approved')">Approve</button>
      <button class="btn light" onclick="editSubmission('${r.id}')">Edit</button>
      <button class="btn red" onclick="review('${r.id}','rejected')">Reject</button>
      <button class="btn red" onclick="deleteSubmission('${r.id}')">Delete</button>
    </div></div>`).join(''):'<div class="notice good">No pending submissions.</div>';

  const ap=a.filter(r=>r.status!=='pending');
  reportBody.innerHTML=ap.length?ap.map(r=>`<tr>
    <td>${esc(r.date)}</td><td>${esc(r.employee)}</td><td>${esc(r.position)}</td><td>${esc(r.shift)}</td>
    <td>${r.breakMode==='with'?'With Break':r.breakMode==='without'?'Without Break':'N/A'}</td>
    <td>${esc(r.clock)}</td>
    <td>$${(+(r.grandTotal||0)).toFixed(2)}</td>
    <td>${['DOUBLE','LONG'].includes(r.shift)?'$'+(+(r.totalAM||0)).toFixed(2):'—'}</td>
    <td>$${(+r.meal).toFixed(2)}</td><td>$${(+r.cashTip).toFixed(2)}</td>
    <td><span class="status ${r.status}">${esc(r.status)}</span></td><td>${esc(r.reviewedBy||'')}</td>
    <td><div class="actions"><button class="btn light" style="padding:6px 8px" onclick="editSubmission('${r.id}')">Edit</button><button class="btn red" style="padding:6px 8px" onclick="deleteSubmission('${r.id}')">Delete</button></div></td>
  </tr>`).join(''):'<tr><td colspan="13">No reviewed records.</td></tr>';
}
window.review=async(id,status)=>{
  const ref=doc(db,'submissions',id);
  const beforeSnap=await getDoc(ref);
  const before=beforeSnap.exists()?beforeSnap.data():null;
  await updateDoc(ref,{status,reviewedBy:currentProfile.displayName||currentProfile.username,reviewedAt:serverTimestamp(),updatedAt:serverTimestamp()});
  await writeAudit(status==='approved'?'approve':'reject',id,before?.employee||'',{before,after:{status}});
};

function listenUsers(){
  unsubs.push(onSnapshot(collection(db,'users'),snap=>{
    const a=snap.docs.map(d=>({uid:d.id,...d.data()})).sort((a,b)=>(a.username||'').localeCompare(b.username||''));
    userList.innerHTML=a.map(u=>`<div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #edf0f4;padding:9px 0"><div><b>${esc(u.displayName||u.username)}</b><div class="small">${esc(u.role)} • ${esc(u.username)}</div></div>${u.role==='owner'?'':`<button class="btn red" style="padding:7px 10px" onclick="disableUser('${u.uid}')">Disable</button>`}</div>`).join('');
  }));
}
window.createUserByOwner=async()=>{
  if(currentProfile.role!=='owner')return;
  const username=uName.value.trim(),role=uRole.value,secret=uPass.value.trim();
  if(!username||!secret)return alert('Username and PIN/password required.');
  let secondaryApp=null;
  try{
    secondaryApp=initializeApp(FIREBASE_CONFIG,'create-user-'+Date.now());
    const secondaryAuth=getAuth(secondaryApp);
    const cred=await createUserWithEmailAndPassword(secondaryAuth,emailFor(username),secret);
    await setDoc(doc(db,'users',cred.user.uid),{
      username:username.toLowerCase(),
      displayName:username,
      role,
      active:true,
      createdAt:serverTimestamp(),
      createdBy:currentUser.uid
    });
    await writeAudit('user_create',cred.user.uid,username,{role});
    await signOut(secondaryAuth);
    alert(`Created ${role}: ${username}`);
    uName.value='';uPass.value='';
  }catch(e){
    alert(e.message||'Create user failed.');
  }finally{
    if(secondaryApp)try{await deleteApp(secondaryApp)}catch(e){}
  }
};
window.disableUser=async uid=>{
  if(currentProfile.role!=='owner')return;
  if(!confirm('Disable this user?'))return;
  const ref=doc(db,'users',uid);
  const s=await getDoc(ref);
  const before=s.exists()?s.data():null;
  await updateDoc(ref,{active:false});
  await writeAudit('user_disable',uid,before?.displayName||before?.username||'',{before});
};


async function writeAudit(action,submissionId,employee,details={}){
  if(!currentUser || !currentProfile)return;
  const ref=doc(collection(db,'auditLogs'));
  await setDoc(ref,{
    action,
    submissionId:submissionId||'',
    employee:employee||'',
    actorUid:currentUser.uid,
    actor:currentProfile.displayName||currentProfile.username,
    actorRole:currentProfile.role,
    details,
    createdAt:serverTimestamp()
  });
}

window.openAddSubmission=()=>{
  mId.value='';
  editTitle.textContent='Add Submission';
  mEmployee.value='';mDate.value=todayLocal();mPosition.value='Server';mShift.value='AM';mBreakMode.value='none';mClock.value='';
  mGrandTotal.value=0;mTotalAM.value=0;mMeal.value=0;mCash.value=0;
  editModal.classList.remove('hidden');
};
window.closeEditModal=()=>editModal.classList.add('hidden');

window.editSubmission=id=>{
  const r=latestRows.find(x=>x.id===id);if(!r)return;
  mId.value=id;editTitle.textContent='Edit Submission';
  mEmployee.value=r.employee||'';mDate.value=r.date||todayLocal();mPosition.value=r.position||'Server';mShift.value=r.shift||'AM';mBreakMode.value=r.breakMode||'none';mClock.value=r.clock||'';
  mGrandTotal.value=r.grandTotal||0;mTotalAM.value=r.totalAM||0;mMeal.value=r.meal||0;mCash.value=r.cashTip||0;
  editModal.classList.remove('hidden');
};

window.saveStaffSubmission=async()=>{
  if(!['manager','owner'].includes(currentProfile.role))return;
  const id=mId.value.trim();
  const payload={
    employee:mEmployee.value.trim(),
    employeeUid:'',
    date:mDate.value,
    position:mPosition.value,
    shift:mShift.value,
    breakMode:mBreakMode.value,
    clock:mClock.value.trim(),
    grandTotal:Number(mGrandTotal.value)||0,
    totalAM:Number(mTotalAM.value)||0,
    meal:Number(mMeal.value)||0,
    cashTip:Number(mCash.value)||0,
    updatedAt:serverTimestamp()
  };
  if(!payload.employee || !payload.date)return alert('Employee and date required.');
  if(id){
    const ref=doc(db,'submissions',id);
    const s=await getDoc(ref);const before=s.exists()?s.data():null;
    await updateDoc(ref,payload);
    await writeAudit('edit',id,payload.employee,{before,after:payload});
  }else{
    const ref=doc(collection(db,'submissions'));
    const full={...payload,status:'approved',reviewedBy:currentProfile.displayName||currentProfile.username,reviewedAt:serverTimestamp(),createdAt:serverTimestamp()};
    await setDoc(ref,full);
    await writeAudit('manager_add',ref.id,payload.employee,{after:full});
  }
  closeEditModal();
};

window.deleteSubmission=async id=>{
  if(!['manager','owner'].includes(currentProfile.role))return;
  if(!confirm('Delete this submission?'))return;
  const ref=doc(db,'submissions',id);
  const s=await getDoc(ref);const before=s.exists()?s.data():null;
  await deleteDoc(ref);
  await writeAudit('delete',id,before?.employee||'',{before});
};

function listenHistory(){
  if(currentProfile.role!=='owner')return;
  const q=query(collection(db,'auditLogs'),orderBy('createdAt','desc'),limit(500));
  unsubs.push(onSnapshot(q,snap=>{
    const rows=snap.docs.map(d=>({id:d.id,...d.data()}));
    historyBody.innerHTML=rows.length?rows.map(r=>{
      let time='';
      try{time=r.createdAt?.toDate? r.createdAt.toDate().toLocaleString():''}catch(e){}
      return `<tr><td>${esc(time)}</td><td>${esc(r.actor||'')}</td><td>${esc(r.actorRole||'')}</td><td>${esc(r.action||'')}</td><td>${esc(r.employee||'')}</td><td>${esc(r.submissionId||'')}</td><td>${esc(JSON.stringify(r.details||{}).slice(0,300))}</td></tr>`;
    }).join(''):'<tr><td colspan="7">No history yet.</td></tr>';
  }));
}

window.requestNotify=async()=>{if(!('Notification' in window))return alert('Notifications not supported here.');const p=await Notification.requestPermission();alert('Notification permission: '+p)};
function notifyManager(r){if(typeof Notification!=='undefined'&&Notification.permission==='granted'){new Notification('New Employee Submission',{body:`${r.employee} — ${r.shift}`,icon:'icon-192.png'})}}

window.exportCSV=()=>{
  const rows=[['Date','Employee','Position','Shift','Break','Clock','Grand Total','Total AM','Meal','Cash Tip','Status','Reviewed By'],...latestRows.map(r=>[r.date,r.employee,r.position,r.shift,r.breakMode||'none',r.clock,r.grandTotal||0,r.totalAM||0,r.meal,r.cashTip,r.status,r.reviewedBy||''])];
  const csv=rows.map(r=>r.map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(',')).join('\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='Juicy_Tip_Report.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
};

eDate.value=todayLocal();

refreshClockMode();
