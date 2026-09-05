(function(){
const $=id=>document.getElementById(id), money=v=>'$'+Number(v||0).toFixed(2);
const groups=[['A',['A1','A2','A3','A4']],['B',['B1','B2','B3']],['Bar',Array.from({length:12},(_,i)=>'Bar'+(i+1))],['C',['C1','C2','C3','C4']],['D',['D1','D2','D3']],['E',['E1','E2','E3','E4','E5']],['H',['H1','H2','H3','H4']],['L',['L1','L2','L3','L4','L5','L6']],['M',['M1','M2']],['R',['R1','R2','R3','R4','R5','R6','R7']]];
let draft=[],selected='',edit=-1;
function emp(){
  const role=window.__getCurrentRole?.()||'';
  const p=$('employeeTipCheckContent');
  if(role!=='employee'){
    draft.length=0;
    selected='';
    edit=-1;
    $('sxEntry')?.remove();
    $('sxModal')?.remove();
    return;
  }
  if(!p||$('sxEntry'))return;const c=document.createElement('div');c.className='card';c.id='sxEntry';c.innerHTML=`<div class="sxhead"><div><h2>Check Tip</h2><div class="small">Add tickets one at a time.</div></div><button type="button" class="btn green" id="sxAdd">+ Add Ticket</button></div><div class="grid"><div><label>Date</label><input id="sxDate" type="date"></div><div><label>Employee</label><input id="sxEmp" readonly></div></div><div id="sxPreview"></div><div class="actions"><button type="button" class="btn light" id="sxClear">Clear All</button><button type="button" class="btn green" id="sxSubmit">Submit to Cashier</button></div>`;p.prepend(c);const old=[...p.children].find(x=>x!==c&&x.classList.contains('card'));if(old)old.style.display='none';$('sxDate').value=$('eTipCheckDate')?.value||new Date().toISOString().slice(0,10);$('sxEmp').value=$('eTipCheckEmployee')?.value||$('whoText')?.textContent||'';$('sxAdd').onclick=()=>open();$('sxClear').onclick=(ev)=>{
  ev?.preventDefault?.();
  ev?.stopPropagation?.();

  // Clear only CURRENT UNSENT Check Tip draft.
  // Submitted / Waiting Cashier history must remain untouched.
  if(draft.length>0 && !confirm('Clear all unsent tickets?')) return false;

  draft.splice(0,draft.length);
  selected='';
  edit=-1;

  const ticket=$('sxTicket');
  const tip=$('sxTip');
  const selectedLabel=$('sxSel');
  const modal=$('sxModal');

  if(ticket) ticket.value='';
  if(tip) tip.value='';
  if(selectedLabel) selectedLabel.innerHTML='<b>Selected Table:</b> None';
  if(modal) modal.style.display='none';

  // Reset any hidden/legacy employee Check Tip input rows that may still exist.
  document.querySelectorAll(
    '[id^="eTipCheckCheck"],[id^="eTipCheckTable"],[id^="eTipCheckTip"],' +
    '[id^="tipCheckCheck"],[id^="tipCheckTable"],[id^="tipCheckTip"]'
  ).forEach(el=>{
    if('value' in el) el.value='';
  });

  preview();

  // Force visual state in case an older preview branch was cached.
  const host=$('sxPreview');
  if(host && draft.length===0){
    host.innerHTML='<div class="notice warn">No tickets entered yet. Tap <b>+ Add Ticket</b>.</div>';
  }

  return false;
};$('sxSubmit').addEventListener('click',submit);modal();preview()}
function modal(){if($('sxModal'))return;const m=document.createElement('div');m.id='sxModal';m.className='sxmodal';m.style.display='none';m.innerHTML=`<div class="card sxdialog"><div class="sxhead"><h2>Add Tip Ticket</h2><button type="button" class="btn light" id="sxClose">Close</button></div><div class="grid"><div><label>Ticket Number</label><input id="sxTicket" class="sxbig" inputmode="numeric"></div><div><label>Total Tip ($)</label><input id="sxTip" class="sxbig" type="number" min="0" step=".01"></div></div><h3>Choose Table</h3><div id="sxTables"></div><div id="sxSel" class="notice good"><b>Selected Table:</b> None</div><div class="actions"><button type="button" class="btn light" id="sxMore">Add More</button><button type="button" class="btn green" id="sxFinish">Finish</button></div></div>`;document.body.appendChild(m);$('sxClose').onclick=close;$('sxMore').onclick=()=>save(1);$('sxFinish').onclick=()=>save(0)}
function tables(){$('sxTables').innerHTML=groups.map(([g,a])=>`<div class="sxgrp"><b>${g}</b><div>${a.map(v=>`<button type="button" class="sxtable ${selected===v?'on':''}" data-v="${v}">${v}</button>`).join('')}</div></div>`).join('');document.querySelectorAll('.sxtable').forEach(b=>b.onclick=()=>{selected=b.dataset.v;tables();$('sxSel').innerHTML='<b>Selected Table:</b> '+selected})}
function open(i=-1){edit=i;const r=i>=0?draft[i]:null;$('sxTicket').value=r?.checkNumber||'';$('sxTip').value=r?.tip||'';selected=r?.table||'';tables();$('sxSel').innerHTML='<b>Selected Table:</b> '+(selected||'None');$('sxModal').style.display='flex';$('sxModal').scrollTop=0;document.querySelector('.sxdialog')?.scrollTo(0,0)}
function close(){$('sxModal').style.display='none';edit=-1}
function save(more){const n=$('sxTicket').value.trim(),tip=Number($('sxTip').value||0);if(!n)return alert('Enter Ticket Number.');if(!selected)return alert('Choose a Table.');if(!Number.isFinite(tip)||tip<0)return alert('Enter a valid Total Tip.');const r={checkNumber:n,table:selected,tip};if(edit>=0)draft[edit]=r;else draft.push(r);edit=-1;preview();if(more){$('sxTicket').value='';$('sxTip').value='';selected='';tables();$('sxSel').innerHTML='<b>Selected Table:</b> None'}else close()}
function preview(){const e=$('sxPreview');if(!e)return;const total=draft.reduce((s,r)=>s+Number(r.tip||0),0);e.innerHTML=draft.length?`<div class="tablewrap"><table class="sxt"><thead><tr><th>#</th><th>Ticket</th><th>Table</th><th>Tip</th><th>Action</th></tr></thead><tbody>${draft.map((r,i)=>`<tr><td>${i+1}</td><td><b>${r.checkNumber}</b></td><td><b>${r.table}</b></td><td>${money(r.tip)}</td><td><button class="btn light" data-e="${i}">Edit</button> <button class="btn red" data-d="${i}">Delete</button></td></tr>`).join('')}</tbody><tfoot><tr><td colspan="3"><b>Total Submitted Tip</b></td><td colspan="2"><b>${money(total)}</b></td></tr></tfoot></table></div>`:'<div class="notice">No tickets entered yet. Tap <b>+ Add Ticket</b>.</div>';e.querySelectorAll('[data-e]').forEach(b=>b.onclick=()=>open(+b.dataset.e));e.querySelectorAll('[data-d]').forEach(b=>b.onclick=()=>{draft.splice(+b.dataset.d,1);preview()})}
async function submit(ev){
  ev?.preventDefault?.();
  ev?.stopPropagation?.();

  if(!draft.length){
    alert('Add at least one ticket.');
    return false;
  }

  const btn=$('sxSubmit');
  if(btn?.dataset.busy==='1')return false;
  if(btn){
    btn.dataset.busy='1';
    btn.disabled=true;
    btn.textContent='Submitting...';
  }

  try{
    const rows=draft.map((r,i)=>({
      line:i+1,
      checkNumber:r.checkNumber,
      table:r.table,
      tip:Number(r.tip||0)
    }));
    const ok=await window.submitEmployeeTipCheckRows($('sxDate')?.value||'',rows);
    if(!ok)return false;

    draft.length=0;
    selected='';
    edit=-1;
    preview();
    alert('Check Tip submitted to Cashier.');
    return true;
  }finally{
    if(btn){
      btn.dataset.busy='0';
      btn.disabled=false;
      btn.textContent='Submit to Cashier';
    }
  }
}
function review(){
  const role=window.__getCurrentRole?.()||'';
  const p=$('tipCheck');
  if(role==='employee'){
    $('sxReview')?.remove();
    if(p) p.style.display='none';
    return;
  }
  if(!['cashier','manager','owner'].includes(role))return;
  if(!p)return;
  // Restore the Check Tip panel after a previous Employee session hid it.
  p.style.display='';
  if($('sxReview'))return;
  [...p.children].forEach(x=>x.style.display='none');
  const c=document.createElement('div');c.className='card';c.id='sxReview';
  const ownerTools=role==='owner'?`<div class="sxOwnerTools">
    <button class="btn light" onclick="downloadTipCheckPdf()">Download PDF</button>
    <button class="btn light" onclick="downloadTipCheckXls()">Download XLS</button>
    <button class="btn light" onclick="shareTipCheckPdf('whatsapp')">PDF to WhatsApp</button>
    <button class="btn light" onclick="shareTipCheckPdf('email')">PDF to Email</button>
    <button class="btn light" onclick="shareTipCheckXls('whatsapp')">XLS to WhatsApp</button>
    <button class="btn light" onclick="shareTipCheckXls('email')">XLS to Email</button>
    <button class="btn red" onclick="clearAllTipCheckSheets()">Clear All</button>
  </div>`:'';
  c.innerHTML=`<div class="sxhead"><div><h2>Check Tip Review</h2><div class="small">Choose Date and Employee. All submissions are combined.</div></div>${ownerTools}</div>
  <div class="sxfilter"><div><label>Date</label><input id="sxRD" type="date"></div><div><label>Employee</label><select id="sxRN"><option value="">Select Employee</option></select></div><div><button class="btn green" id="sxView">View Tips</button></div></div>
  <div id="sxBody"><div class="notice">Choose Date and Employee, then tap View Tips.</div></div>`;
  p.appendChild(c);
  $('sxRD').value=new Date().toISOString().slice(0,10);$('sxRD').onchange=names;$('sxView').onclick=draw;names()}
function data(){return window.__getTipCheckSheets?.()||[]}
function names(){const d=$('sxRD')?.value,n=$('sxRN');if(!n)return;const old=n.value,a=[...new Set(data().filter(s=>s.date===d).map(s=>s.employeeName).filter(Boolean))].sort();n.innerHTML='<option value="">Select Employee</option>'+a.map(x=>`<option>${x}</option>`).join('');if(a.includes(old))n.value=old}
function draw(){
  if(!['cashier','manager','owner'].includes(window.__getCurrentRole?.()||'')){
    alert('Cashier, Manager, or Owner login required.');
    return;
  }
  const d=$('sxRD').value,n=$('sxRN').value;if(!d||!n)return alert('Select Date and Employee.');const f=[];data().filter(s=>s.date===d&&s.employeeName===n).forEach(s=>(s.rows||[]).forEach((r,i)=>f.push({s,r,i})));const done=f.filter(x=>x.r.result==='done'),ns=f.filter(x=>x.r.result==='no_signature'),nf=f.filter(x=>x.r.result==='ticket_not_found'),submitted=f.reduce((a,x)=>a+Number(x.r.tip||0),0),approved=done.reduce((a,x)=>a+Number(x.r.tip||0),0);const role=window.__getCurrentRole?.()||'';
  const selectedSheets=[...new Map(f.map(x=>[String(x.s.id),x.s])).values()];
  const ownerSheetTools=role==='owner'?`<div class="sxOwnerSheetTools">
    ${selectedSheets.map((s,idx)=>`<button class="btn light" data-full-edit="${s.id}">Edit Full Sheet ${selectedSheets.length>1?idx+1:''}</button>
      <button class="btn red" data-del-sheet="${s.id}">Delete Sheet ${selectedSheets.length>1?idx+1:''}</button>`).join('')}
  </div>`:'';
  $('sxBody').innerHTML=`<div class="sxhead"><div><h2>${n}</h2><div class="small">${d} • ${f.length} tickets</div></div>${ownerSheetTools}</div><div class="sxsum"><div><small>Submitted Tip</small><b>${money(submitted)}</b></div><div><small>Approved Tip</small><b>${money(approved)}</b></div><div><small>Done</small><b>${done.length}</b></div><div><small>No Signature</small><b>${ns.length}</b></div><div><small>Ticket Not Found</small><b>${nf.length}</b></div></div><div class="notice good"><b>Approved Tip includes Done tickets only.</b> Problem tickets do not increase the approved total.</div><div class="tablewrap"><table class="sxrt"><thead><tr><th>Ticket</th><th>Table</th><th>Tip</th><th>Result</th><th>Action</th></tr></thead><tbody>${f.map(x=>`<tr><td><b>${x.r.checkNumber||''}</b></td><td><b>${x.r.table||''}</b></td><td>${money(x.r.tip)}</td><td><select id="rr_${x.s.id}_${x.i}"><option value="">Select Result</option><option value="done" ${x.r.result==='done'?'selected':''}>Done</option><option value="no_signature" ${x.r.result==='no_signature'?'selected':''}>No Signature</option><option value="ticket_not_found" ${x.r.result==='ticket_not_found'?'selected':''}>Ticket Not Found</option></select></td><td><button class="btn light" data-s="${x.s.id}|${x.i}">Save</button> <button class="btn red" data-x="${x.s.id}|${x.i}">Delete</button></td></tr>`).join('')}</tbody></table></div><div id="sxComplete"></div>`;completeArea(f,d,n);document.querySelectorAll('[data-s]').forEach(b=>b.onclick=async()=>{const [id,i]=b.dataset.s.split('|'),v=$('rr_'+id+'_'+i).value;if(!v)return alert('Select a result.');const ok=await window.saveTipCheckRow(id,+i,v);if(ok){await window.__refreshTipCheckSheets?.();setTimeout(()=>{names();draw()},250)}});document.querySelectorAll('[data-x]').forEach(b=>b.onclick=async()=>{const [id,i]=b.dataset.x.split('|');await window.deleteTipCheckRow(id,+i);setTimeout(draw,400)});
  document.querySelectorAll('[data-full-edit]').forEach(b=>b.onclick=()=>window.ownerOpenTipCheckSheet(b.dataset.fullEdit));
  document.querySelectorAll('[data-del-sheet]').forEach(b=>b.onclick=async()=>{await window.deleteTipCheckSheet(b.dataset.delSheet);await window.__refreshTipCheckSheets?.();names();setTimeout(draw,300)});
}

function completeArea(flat,date,name){
  const area=$('sxComplete'); if(!area)return;
  const uniqueSheets=[...new Map(flat.map(x=>[String(x.s.id),x.s])).values()];
  const missing=flat.filter(x=>!x.r.result).length;
  const allCompleted=uniqueSheets.length>0 && uniqueSheets.every(s=>s.status==='cashier_completed');

  if(allCompleted){
    area.innerHTML=`<div class="notice good" style="margin-top:16px"><b>CASHIER COMPLETED</b><br>The completed result has been sent to ${name}. This report remains available in Cashier history.</div>`;
    return;
  }

  if(missing){
    area.innerHTML=`<div class="notice warning" style="margin-top:16px"><b>${missing} ticket(s) still need a saved result.</b><br>Choose Done, No Signature, or Ticket Not Found and tap Save for each remaining ticket.</div>
      <button class="btn green sxCompleteBtn" disabled>Submit Completed Checklist</button>`;
    return;
  }

  area.innerHTML=`<button class="btn green sxCompleteBtn" id="sxCompleteBtn">Submit Completed Checklist</button>
    <div class="small" style="text-align:center;margin-top:8px">This completes all ${name} Check Tip submissions for ${date} and sends the result to the employee.</div>`;

  $('sxCompleteBtn').onclick=async()=>{
    if(!confirm(`Submit completed checklist for ${name} on ${date}?`))return;
    const btn=$('sxCompleteBtn');
    btn.disabled=true; btn.textContent='Submitting...';
    const ok=await window.completeGroupedTipCheck(uniqueSheets.map(s=>s.id));
    if(ok){
      await window.__refreshTipCheckSheets?.();
      names();
      draw();
      alert('Completed checklist submitted. The employee can now see the Check Tip result.');
    }else{
      btn.disabled=false; btn.textContent='Submit Completed Checklist';
    }
  };
}

setInterval(()=>{
  emp();
  review();
  const role=window.__getCurrentRole?.()||'';
  if(['cashier','manager','owner'].includes(role)){
    const p=$('tipCheck');
    if(p) p.style.display='';
    if(role==='owner' && $('tipCheckManagerBlock') && $('staffTipCheckEditId')?.value){
      $('tipCheckManagerBlock').style.display='';
      $('tipCheckManagerBlock').classList.remove('hidden');
    }
    names();
  }
},900);
})();

// V13.3.2 Save fix

// V13.3.3 big grouped completion button

// V13.3.4: role-separated employee/cashier UI.

// V13.3.5 employee completion display compatibility.

// V13.3.6 cache-busted UI bundle.

// V13.3.7: restore Cashier Check Tip history after Employee logout/login role switch.

// V13.3.8 Owner full controls UI.

// V13.4.2: original owner/cashier unified Check Tip UI preserved.

// V13.4.3 Original Hourly UI compatibility.

// V13.4.4 cache-busted UI.

// V13.4.5: Employee Check Tip Clear All fixed and labels corrected.

// V13.4.6 cache bust.

setInterval(()=>{
  if((window.__getCurrentRole?.()||'')==='employee'){
    const old=document.getElementById('employeeBottom');
    if(old){ old.classList.add('hidden'); old.style.display='none'; }
  }
},500);

// V13.4.7 robust Check Tip Clear All.

// V13.4.8 cache bust.

// V13.4.9: robust Employee Clear All and normal one-tap submit.

// V13.5.0 cache-busted Check Tip UI.

// V13.5.1 cache-busted Check Tip UI.

// V13.5.2 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

document.addEventListener('click',(ev)=>{
  const btn=ev.target?.closest?.('#sxClear');
  if(!btn) return;
  ev.preventDefault();
  ev.stopPropagation();

  if(typeof draft!=='undefined'){
    if(draft.length>0 && !confirm('Clear all unsent tickets?')) return;
    draft.splice(0,draft.length);
  }
  try{ selected=''; edit=-1; }catch(e){}

  const ticket=document.getElementById('sxTicket');
  const tip=document.getElementById('sxTip');
  const sel=document.getElementById('sxSel');
  const modal=document.getElementById('sxModal');
  if(ticket) ticket.value='';
  if(tip) tip.value='';
  if(sel) sel.innerHTML='<b>Selected Table:</b> None';
  if(modal) modal.style.display='none';

  document.querySelectorAll(
    '[id^="eTipCheckCheck"],[id^="eTipCheckTable"],[id^="eTipCheckTip"],' +
    '[id^="tipCheckCheck"],[id^="tipCheckTable"],[id^="tipCheckTip"]'
  ).forEach(el=>{ if('value' in el) el.value=''; });

  try{ preview(); }catch(e){}
},true);

// V13.8.1 deterministic employee Clear All.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.

// V13.8.1 cache bump.
