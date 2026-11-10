import { scanXmlSpans } from './sourcePreservingXml';

/** Remove only top-level legacy forwarding inputs, preserving all other bytes. */
export function removeLegacyForwarderXml(xml:string):string {
  if(!xml.includes('MAVLINK_FORWARD'))return xml;
  const spans=scanXmlSpans(xml,true).children.filter(span=>{
    if(span.tag!=='input')return false;
    const opening=span.disabledXml??xml.slice(span.start,span.openEnd);
    return /\btype\s*=\s*(["'])MAVLINK_FORWARD\1/.test(opening);
  }).sort((a,b)=>b.start-a.start);
  for(const span of spans)xml=xml.slice(0,span.start)+xml.slice(span.end);
  return xml;
}
export function withoutLegacyForwarders<T extends {nodes:Array<{id:string;data:{componentType:string}}>;edges:Array<{source:string;target:string}>}>(project:T):T {
  const removed=new Set(project.nodes.filter(n=>n.data.componentType==='mavlink_forwarder').map(n=>n.id));
  if(!removed.size)return project;
  return {...project,nodes:project.nodes.filter(n=>!removed.has(n.id)),edges:project.edges.filter(e=>!removed.has(e.source)&&!removed.has(e.target))};
}
