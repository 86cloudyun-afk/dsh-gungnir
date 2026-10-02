const clean = (v, max = 240) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : null;
const key = (a,t,s) => JSON.stringify([a,t,s]);
export function projectFacts(rows, diagnostics) {
  const decoded=[];
  for (const row of rows) {
    try { const p=JSON.parse(row.payload); decoded.push({...row,payload:p && typeof p==='object'&&!Array.isArray(p)?p:{}}); }
    catch { diagnostics.warnings.push(`Malformed payload on fact ${row.id}`); }
  }
  const active=decoded.filter(r=>r.active===1), ids=new Map(active.map(r=>[key(r.adapter_instance,r.entity_type,r.source_id),`fact:${r.id}`]));
  const nodes=active.map(r=>{
    const p=r.payload; const numeric=Number(p.layer);
    return {id:ids.get(key(r.adapter_instance,r.entity_type,r.source_id)),source_id:clean(r.source_id),adapter_instance:clean(r.adapter_instance),entity_type:clean(r.entity_type),label:clean(p.label)||clean(r.source_id),layer:Number.isInteger(numeric)?Math.max(0,Math.min(4,numeric)):layerFor(r.entity_type),state:state(p.state),route_ids:strings(p.route_ids),task_ids:strings(p.task_ids),highest_proof:enumOrNull(p.highest_proof,['none','likely','confirmed']),current_validity:enumOrNull(p.current_validity,['unknown','likely','confirmed_lost']),updated_at:clean(r.ts,40)};
  });
  const bySource=new Map(); for(const r of active){const arr=bySource.get(r.source_id)||[];arr.push(r);bySource.set(r.source_id,arr);}
  const edges=[];
  const resolve=ref=>{
    if(ref && typeof ref==='object' && ref.adapter_instance && ref.entity_type && ref.source_id) return ids.get(key(ref.adapter_instance,ref.entity_type,ref.source_id))||null;
    if(ref && typeof ref==='object' && ref.source_id){const same=active.filter(x=>x.adapter_instance===ref.adapter_instance&&x.source_id===ref.source_id); if(ref.adapter_instance && same.length===1)return ids.get(key(same[0].adapter_instance,same[0].entity_type,same[0].source_id)); const all=bySource.get(ref.source_id)||[]; if(all.length===1)return ids.get(key(all[0].adapter_instance,all[0].entity_type,all[0].source_id)); if(all.length>1)diagnostics.ambiguous_refs++; else diagnostics.unresolved_refs++; return null;}
    diagnostics.unresolved_refs++; return null;
  };
  for(const r of active){const p=r.payload, from=ids.get(key(r.adapter_instance,r.entity_type,r.source_id)); for(const ref of [...(Array.isArray(p.refs)?p.refs:[]),...(Array.isArray(p.edges)?p.edges:[])]){const obj=ref?.to??ref, to=resolve(obj);if(to&&to!==from){edges.push({id:`edge:${r.id}:${edges.length}`,from,to,label:clean(ref?.label)||'引用',kind:ref?.kind==='explicit'?'explicit':'reference',route_ids:strings(ref?.route_ids)});}}}
  return {nodes,edges,decoded};
}
function strings(x){return Array.isArray(x)?x.filter(v=>typeof v==='string').map(v=>clean(v,120)).filter(Boolean):[];}
function state(x){return ['verified','pending','failed'].includes(x)?x:'unknown';}
function enumOrNull(x,allowed){return allowed.includes(x)?x:null;}
function layerFor(t){return ({jumphost:0,asset:1,evidence:2,chain:3,conclusion:4})[t]??2;}
