try { if (typeof process.loadEnvFile === "function") process.loadEnvFile(); } catch {}

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");
const { analyzePhoto } = require("./ai-photo-service.js");

const ROOT = path.resolve(__dirname, "..");
const IS_VERCEL = Boolean(process.env.VERCEL);
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const SESSION_COOKIE = "photography_admin";
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "portfolio-images";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("Missing SUPABASE_URL and SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY).");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const ALLOWED_IMAGE_TYPES = new Map([
  ["image/jpeg", ".jpg"], ["image/png", ".png"], ["image/webp", ".webp"], ["image/avif", ".avif"],
]);
const MIME_BY_EXTENSION = new Map([
  [".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"], [".json", "application/json; charset=utf-8"],
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".webp", "image/webp"], [".avif", "image/avif"], [".ico", "image/x-icon"],
]);

const IS_PROD = IS_VERCEL || process.env.NODE_ENV === "production";
if (IS_PROD) {
  const missing = [
    !process.env.SESSION_SECRET && "SESSION_SECRET",
    !process.env.ADMIN_USERNAME && "ADMIN_USERNAME",
    !process.env.ADMIN_PASSWORD && "ADMIN_PASSWORD",
  ].filter(Boolean);
  if (missing.length) throw new Error(`Missing production environment variable(s): ${missing.join(", ")}`);
  if (process.env.ADMIN_PASSWORD.length < 8) throw new Error("ADMIN_PASSWORD must be at least 8 characters.");
} else if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
  throw new Error("Set ADMIN_USERNAME and ADMIN_PASSWORD in .env before starting the CMS.");
}
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-insecure-session-secret-local-only";
const loginAttempts = new Map();
const aiAnalysisCooldowns = new Map();

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  return res.end(JSON.stringify(payload));
}
function readBody(req, limit = MAX_UPLOAD_BYTES + 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", chunk => { size += chunk.length; if (size > limit) { reject(Object.assign(new Error("Request body is too large."), {status:413})); req.destroy(); return; } chunks.push(chunk); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req) {
  const raw = await readBody(req, 2 * 1024 * 1024);
  try { return JSON.parse(raw.toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("Request body must be valid JSON."), {status:400}); }
}
function parseMultipart(buffer, contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw Object.assign(new Error("Missing multipart boundary."), {status:400});
  const boundary = Buffer.from(`--${match[1] || match[2]}`), fields = {}, files = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor !== -1) {
    cursor += boundary.length;
    if (buffer.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) break;
    if (buffer.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n"))) cursor += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), cursor);
    if (headerEnd === -1) break;
    const contentStart = headerEnd + 4;
    const nextBoundary = buffer.indexOf(Buffer.concat([Buffer.from("\r\n"), boundary]), contentStart);
    if (nextBoundary === -1) break;
    const headers = buffer.subarray(cursor, headerEnd).toString("utf8");
    const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || "";
    const nameMatch = disposition.match(/(?:^|;)\s*name=(?:"([^"]*)"|([^;]*))/i);
    const fileMatch = disposition.match(/(?:^|;)\s*filename=(?:"([^"]*)"|([^;]*))/i);
    const name = (nameMatch?.[1] ?? nameMatch?.[2])?.trim();
    const filename = (fileMatch?.[1] ?? fileMatch?.[2])?.trim();
    const data = buffer.subarray(contentStart, nextBoundary);
    if (name && filename !== undefined && filename !== "") {
      let type = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.split(";")[0].trim().toLowerCase() || "";
      if (type === "image/jpg" || type === "image/pjpeg") type = "image/jpeg";
      files.push({name, filename:path.basename(filename), type, data});
    } else if (name) fields[name] = Object.hasOwn(fields,name) ? (Array.isArray(fields[name]) ? [...fields[name], data.toString("utf8")] : [fields[name], data.toString("utf8")]) : data.toString("utf8");
    cursor = nextBoundary + 2;
  }
  return {fields, files};
}
function boolValue(v) { return v === true || v === "true" || v === "1" || v === 1 ? true : false; }
function nowIso() { return new Date().toISOString(); }
function dbError(error) { return Object.assign(new Error(error?.message || "Supabase database request failed."), {status: 500}); }

async function q(promise) {
  const result = await promise;
  if (result.error) throw dbError(result.error);
  return result.data;
}
async function one(table, id) {
  const rows = await q(supabase.from(table).select("*").eq("id", id).limit(1));
  return rows[0] || null;
}
async function storageUpload(filePath, data, mimeType) {
  const result = await supabase.storage.from(STORAGE_BUCKET).upload(filePath, data, {contentType:mimeType, cacheControl:"31536000", upsert:true});
  if (result.error) throw dbError(result.error);
  const {data:pub} = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(filePath);
  return pub.publicUrl;
}
async function storageDelete(filePath) {
  if (!filePath) return;
  const result = await supabase.storage.from(STORAGE_BUCKET).remove([filePath]);
  if (result.error) console.error("Storage delete failed:", result.error.message);
}
function storagePathFromUrl(url) {
  const marker = `/storage/v1/object/public/${STORAGE_BUCKET}/`;
  const i = String(url || "").indexOf(marker);
  return i >= 0 ? decodeURIComponent(String(url).slice(i + marker.length)) : null;
}
async function getSections() {
  const rows = await q(supabase.from("sections").select("*").order("display_order").order("name"));
  return rows.map(s => ({...s, visible:Boolean(s.is_visible), system:Boolean(s.is_system)}));
}
async function getContent() {
  const rows = await q(supabase.from("site_content").select("content_key,content_value"));
  return Object.fromEntries(rows.map(r => [r.content_key,r.content_value]));
}
async function getNavigation() {
  const rows = await q(supabase.from("navigation_items").select("*").order("display_order").order("label"));
  return rows.map(r => ({id:r.id,label:r.label,url:r.url,icon:r.icon,visible:Boolean(r.is_visible),displayOrder:r.display_order}));
}
async function getSkills({visibleOnly=false}={}) {
  let query = supabase.from("skills").select("*").order("display_order").order("name");
  if (visibleOnly) query = query.eq("is_visible",true);
  const rows = await q(query);
  return rows.map(r => ({id:r.id,name:r.name,percent:r.percent,icon:r.icon,displayOrder:r.display_order,visible:Boolean(r.is_visible)}));
}
async function getSocialLinks() {
  const links = await q(supabase.from("social_links").select("*").order("display_order").order("display_name"));
  const locs = links.length ? await q(supabase.from("social_link_locations").select("*").in("social_link_id",links.map(x=>x.id))) : [];
  return links.map(l => ({id:l.id,platform:l.platform,displayName:l.display_name,url:l.url,icon:l.icon,visible:Boolean(l.is_visible),displayOrder:l.display_order,locations:locs.filter(x=>x.social_link_id===l.id).sort((a,b)=>a.display_order-b.display_order).map(x=>x.location)}));
}
async function getPortfolioItems({publicOnly=false}={}) {
  let query = supabase.from("portfolio_items").select("*").order("display_order").order("created_at");
  if (publicOnly) query = query.eq("is_published",true).eq("is_hidden",false);
  const items = await q(query);
  if (!items.length) return [];
  const mediaIds=[...new Set(items.map(x=>x.media_id))];
  const media=await q(supabase.from("media").select("*").in("id",mediaIds));
  const links=await q(supabase.from("portfolio_item_sections").select("*").in("portfolio_item_id",items.map(x=>x.id)));
  const sectionIds=[...new Set(links.map(x=>x.section_id))];
  const sections=sectionIds.length ? await q(supabase.from("sections").select("id,slug").in("id",sectionIds)) : [];
  const mm=new Map(media.map(x=>[x.id,x])), sm=new Map(sections.map(x=>[x.id,x.slug]));
  return items.map(row => {
    const m=mm.get(row.media_id)||{};
    return {id:row.id,mediaId:row.media_id,imageUrl:m.file_url||"",fileName:m.file_name||"",mimeType:m.mime_type||"",altText:m.alt_text||"",aiMetadata:m.ai_metadata||null,title:row.title,description:row.description,category:row.category,location:row.location,photoDate:row.photo_date,tags:row.tags?row.tags.split(",").map(x=>x.trim()).filter(Boolean):[],featured:Boolean(row.is_featured),published:Boolean(row.is_published),hidden:Boolean(row.is_hidden),displayOrder:row.display_order,sections:links.filter(x=>x.portfolio_item_id===row.id).map(x=>sm.get(x.section_id)).filter(Boolean)};
  });
}
async function getPortfolioItem(id) { const rows=await getPortfolioItems(); return rows.find(x=>x.id===id)||null; }
async function saveLocations(itemId, locations) {
  await q(supabase.from("portfolio_item_sections").delete().eq("portfolio_item_id",itemId));
  if (!locations.length) return;
  const sections=await q(supabase.from("sections").select("id,slug").in("slug",locations));
  await q(supabase.from("portfolio_item_sections").insert(sections.map(s=>({portfolio_item_id:itemId,section_id:s.id}))));
}
async function parseLocations(body) {
  const selected=Array.isArray(body.sections)?body.sections:[];
  const known=new Set((await getSections()).map(s=>s.slug));
  const unique=[...new Set(selected.map(String))];
  if (unique.some(s=>!known.has(s))) throw Object.assign(new Error("One or more selected display locations do not exist."),{status:400});
  return unique;
}
function validateExternalUrl(value, schemes=["https:"]) {
  try { const u=new URL(String(value)); if(!schemes.includes(u.protocol)) throw 0; return u.href; }
  catch { throw Object.assign(new Error("Enter a valid URL using an allowed protocol."),{status:400}); }
}
async function mediaUsage(mediaId) {
  const items=await q(supabase.from("portfolio_items").select("id,title,is_published,display_order").eq("media_id",mediaId).order("display_order"));
  if(!items.length) return [];
  const links=await q(supabase.from("portfolio_item_sections").select("portfolio_item_id,section_id").in("portfolio_item_id",items.map(x=>x.id)));
  const sections=links.length?await q(supabase.from("sections").select("id,slug").in("id",links.map(x=>x.section_id))):[];
  const sm=new Map(sections.map(x=>[x.id,x.slug]));
  return items.flatMap(i=>links.filter(l=>l.portfolio_item_id===i.id).map(l=>({id:i.id,title:i.title,is_published:i.is_published,slug:sm.get(l.section_id)||null})));
}
async function cleanupUnusedMedia(mediaId) {
  const refs=await q(supabase.from("portfolio_items").select("id").eq("media_id",mediaId).limit(1));
  if(refs.length) return;
  const media=await one("media",mediaId);
  if(media){ await q(supabase.from("media").delete().eq("id",mediaId)); await storageDelete(storagePathFromUrl(media.file_url)); }
}
async function handleMediaDelete(res,id,mode) {
  const media=await one("media",id); if(!media) return sendJson(res,404,{error:"Media item not found."});
  const usages=await mediaUsage(id);
  if(mode==="remove-from-sections"){
    const ids=[...new Set(usages.map(x=>x.id))];
    if(ids.length){ await q(supabase.from("portfolio_item_sections").delete().in("portfolio_item_id",ids)); await q(supabase.from("portfolio_items").update({is_published:false,updated_at:nowIso()}).in("id",ids)); }
    return sendJson(res,200,{removedFromSections:ids.length});
  }
  if(mode!=="permanent") return sendJson(res,409,{error:"Choose remove-from-sections or permanent deletion.",usage:usages});
  const items=await q(supabase.from("portfolio_items").select("id").eq("media_id",id));
  if(items.length) await q(supabase.from("portfolio_items").delete().eq("media_id",id));
  await q(supabase.from("media").delete().eq("id",id));
  await storageDelete(storagePathFromUrl(media.file_url));
  return sendJson(res,200,{deleted:true});
}
function createSessionToken(username) {
  const expiresAt=Date.now()+SESSION_TTL;
  const payload=Buffer.from(JSON.stringify({u:username,exp:expiresAt}),"utf8").toString("base64url");
  const sig=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verifySessionToken(token) {
  if(!token||typeof token!=="string") return null;
  const i=token.lastIndexOf("."); if(i<0) return null;
  const payload=token.slice(0,i), sig=token.slice(i+1);
  const expected=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
  const a=Buffer.from(sig), b=Buffer.from(expected);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b)) return null;
  try { const d=JSON.parse(Buffer.from(payload,"base64url").toString("utf8")); if(!d||d.u!==process.env.ADMIN_USERNAME||typeof d.exp!=="number"||d.exp<Date.now()) return null; return {username:d.u,expiresAt:d.exp}; } catch { return null; }
}
function getSession(req) {
  const cookie=req.headers.cookie||"", raw=cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];
  if(!raw) return null; const token=decodeURIComponent(raw), session=verifySessionToken(token); return session?{session,key:crypto.createHash("sha256").update(token).digest("hex")}:null;
}
function requireAdmin(req,res) { if(!getSession(req)){sendJson(res,401,{error:"Authentication required."});return false;} return true; }
function isSecureRequest(req) { return IS_VERCEL ? req.headers["x-forwarded-proto"]?.split(",")[0].trim()==="https" : Boolean(req.socket.encrypted); }
function checkOrigin(req,res) {
  const origin=req.headers.origin; if(!origin) return true;
  const proto=IS_VERCEL?(req.headers["x-forwarded-proto"]||"https").split(",")[0].trim():(isSecureRequest(req)?"https":"http");
  const host=IS_VERCEL?(req.headers["x-forwarded-host"]||req.headers.host).split(",")[0].trim():req.headers.host;
  try { const a=new URL(origin), b=new URL(`${proto}://${host}`); if(a.origin!==b.origin){sendJson(res,403,{error:"Cross-origin write requests are not allowed."});return false;} }
  catch { sendJson(res,403,{error:"Invalid request origin."}); return false; }
  return true;
}
function isValidImage(data,type) {
  if(!data||data.length<12) return false;
  type=(type||"").split(";")[0].toLowerCase();
  if(type==="image/jpeg") return data[0]===0xff&&data[1]===0xd8;
  if(type==="image/png") return data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(type==="image/webp") return data.toString("ascii",0,4)==="RIFF"&&data.toString("ascii",8,12)==="WEBP";
  if(type==="image/avif") return data.toString("ascii",4,8)==="ftyp"&&data.subarray(8,128).toString("ascii").includes("avif");
  return false;
}
async function handlePortfolioWrite(req,res,id) {
  try {
    const ct=req.headers["content-type"]||""; let body,imageFile=null;
    if(ct.toLowerCase().startsWith("multipart/form-data")){const p=parseMultipart(await readBody(req),ct);body=p.fields;imageFile=p.files.find(x=>x.name==="photo")||null;} else body=await readJson(req);
    const existing=id?await one("portfolio_items",id):null;
    if(id&&!existing)return sendJson(res,404,{error:"Portfolio item not found."});
    if(!existing&&!imageFile)return sendJson(res,400,{error:"Choose an image file to upload."});
    if(imageFile){if(!ALLOWED_IMAGE_TYPES.has(imageFile.type)||!isValidImage(imageFile.data,imageFile.type))return sendJson(res,415,{error:"Upload a valid JPEG, PNG, WebP, or AVIF image."});if(imageFile.data.length>MAX_UPLOAD_BYTES)return sendJson(res,413,{error:"Image exceeds the 12 MB limit."});}
    const title=String(body.title||"").trim(); if(!title)return sendJson(res,400,{error:"Photo title is required."});
    const sections=new Set(await parseLocations(body));
    if(boolValue(body.featured))sections.add("featured");else sections.delete("featured");
    const category=String(body.category||"").trim();
    const custom=category?await q(supabase.from("sections").select("id").eq("slug",category).eq("is_system",false).limit(1)):[];
    if(custom.length)sections.add(category);
    const oldCategory=existing?.category; if(oldCategory&&oldCategory!==category&&!sections.has(oldCategory))sections.delete(oldCategory);
    let mediaId=existing?.media_id||null, uploadedPath=null;
    if(imageFile){
      mediaId=crypto.randomUUID();
      uploadedPath=`portfolio/${mediaId}${ALLOWED_IMAGE_TYPES.get(imageFile.type)}`;
      const publicUrl=await storageUpload(uploadedPath,imageFile.data,imageFile.type);
      await q(supabase.from("media").insert({id:mediaId,file_name:imageFile.filename,file_url:publicUrl,mime_type:imageFile.type,alt_text:String(body.description||"").trim()}));
    }
    const itemId=existing?.id||crypto.randomUUID();
    const payload={media_id:mediaId,title,description:String(body.description||"").trim(),category,location:String(body.location||"").trim(),photo_date:String(body.photoDate||"").trim(),tags:Array.isArray(body.tags)?body.tags.join(","):String(body.tags||"").trim(),is_featured:boolValue(body.featured),is_published:boolValue(body.published),is_hidden:boolValue(body.hidden),display_order:Number.isFinite(Number(body.displayOrder))?Math.max(0,Number(body.displayOrder)):0,updated_at:nowIso()};
    if(existing) await q(supabase.from("portfolio_items").update(payload).eq("id",itemId)); else await q(supabase.from("portfolio_items").insert({id:itemId,...payload,created_at:nowIso()}));
    await saveLocations(itemId,[...sections]);
    if(mediaId){
      const alt=body.altText??body.alt_text;
      const update={}; if(typeof alt==="string")update.alt_text=alt.trim();
      if(body.aiMetadata){try{const raw=typeof body.aiMetadata==="string"?JSON.parse(body.aiMetadata):body.aiMetadata;update.ai_metadata=JSON.stringify({subject:String(raw.subject||"").trim(),scene:String(raw.scene||"").trim(),mood:String(raw.mood||"").trim(),lighting:String(raw.lighting||"").trim(),composition:String(raw.composition||"").trim(),style:String(raw.style||"").trim(),analyzedAt:raw.analyzedAt||nowIso()});}catch{}}
      if(Object.keys(update).length)await q(supabase.from("media").update(update).eq("id",mediaId));
    }
    if(existing&&imageFile&&existing.media_id!==mediaId)await cleanupUnusedMedia(existing.media_id);
    return sendJson(res,existing?200:201,await getPortfolioItem(itemId));
  }catch(e){return sendJson(res,e.status||500,{error:e.status?e.message:"Could not save portfolio item."});}
}
async function handlePortfolioDelete(res,id){
  try{
    const item=await one("portfolio_items",id); if(!item)return sendJson(res,404,{error:"Portfolio item not found."});
    const mediaId=item.media_id; await q(supabase.from("portfolio_items").delete().eq("id",id)); await cleanupUnusedMedia(mediaId);
    return sendJson(res,200,{deleted:true});
  }catch(e){return sendJson(res,500,{error:"Could not delete portfolio item."});}
}
async function handleSectionWrite(req,res,id){
  try{
    const b=await readJson(req), name=String(b.name||"").trim(), title=String(b.title||"").trim(), slug=String(b.slug||"").trim().toLowerCase();
    if(!name||!title||!slug)return sendJson(res,400,{error:"Name, title, and slug are required."});
    if(!/^[a-z0-9-]+$/.test(slug))return sendJson(res,400,{error:"Slug may contain only lowercase letters, numbers, and hyphens."});
    if(id){const ex=await one("sections",id);if(!ex)return sendJson(res,404,{error:"Section not found."});if(ex.is_system)return sendJson(res,400,{error:"System sections cannot be edited here."});await q(supabase.from("sections").update({name,title,description:String(b.description||""),slug,is_visible:boolValue(b.visible),display_order:Number(b.displayOrder)||0}).eq("id",id));}
    else {await q(supabase.from("sections").insert({id:crypto.randomUUID(),name,title,description:String(b.description||""),slug,is_visible:boolValue(b.visible??true),display_order:Number(b.displayOrder)||0,is_system:false}));}
    return sendJson(res,200,await getSections());
  }catch(e){return sendJson(res,e.status||500,{error:e.status?e.message:"Could not save section."});}
}
async function handleSectionDelete(res,id){
  const ex=await one("sections",id);if(!ex)return sendJson(res,404,{error:"Section not found."});if(ex.is_system)return sendJson(res,400,{error:"System sections cannot be deleted."});
  await q(supabase.from("sections").delete().eq("id",id));return sendJson(res,200,{deleted:true});
}
async function handleContentWrite(req,res){
  try{const body=await readJson(req);for(const [key,value] of Object.entries(body)){if(typeof value!=="string")continue;await q(supabase.from("site_content").upsert({content_key:key,content_value:value,updated_at:nowIso()},{onConflict:"content_key"}));}return sendJson(res,200,await getContent());}
  catch(e){return sendJson(res,e.status||500,{error:e.status?e.message:"Could not save site content."});}
}
async function handleSocialWrite(req,res,id){
  try{
    const b=await readJson(req), existing=id?await one("social_links",id):null;if(id&&!existing)return sendJson(res,404,{error:"Social link not found."});
    const platform=String(b.platform||"").trim(),displayName=String(b.displayName||"").trim(),icon=String(b.icon||"").trim();if(!platform||!displayName||!icon)return sendJson(res,400,{error:"Platform, display name, and icon are required."});
    const url=validateExternalUrl(b.url,["https:","mailto:","tel:"]);const locations=Array.isArray(b.locations)?[...new Set(b.locations)]:[];const allowed=new Set(["header","homepage","about","portfolio","contact","footer"]);if(locations.some(x=>!allowed.has(x)))return sendJson(res,400,{error:"Unknown social display location."});
    const linkId=existing?.id||crypto.randomUUID(), row={id:linkId,platform,display_name:displayName,url,icon,is_visible:boolValue(b.visible??true),display_order:Number(b.displayOrder)||0};
    await q(supabase.from("social_links").upsert(row,{onConflict:"id"}));await q(supabase.from("social_link_locations").delete().eq("social_link_id",linkId));if(locations.length)await q(supabase.from("social_link_locations").insert(locations.map((x,i)=>({social_link_id:linkId,location:x,display_order:i}))));
    return sendJson(res,existing?200:201,(await getSocialLinks()).find(x=>x.id===linkId));
  }catch(e){return sendJson(res,e.status||500,{error:e.status?e.message:"Could not save social link."});}
}
async function handleNavigationWrite(req,res,id){
  try{
    const b=await readJson(req),existing=id?await one("navigation_items",id):null;if(id&&!existing)return sendJson(res,404,{error:"Navigation item not found."});
    const label=String(b.label||"").trim(),destination=String(b.url||"").trim();if(!label||!destination||destination.startsWith("//")||/[\r\n]/.test(destination)||/^(javascript|data|vbscript):/i.test(destination))return sendJson(res,400,{error:"Navigation label and a safe URL are required."});
    const row={id:existing?.id||crypto.randomUUID(),label,url:destination,icon:String(b.icon||""),is_visible:boolValue(b.visible??true),display_order:Number(b.displayOrder)||0};await q(supabase.from("navigation_items").upsert(row,{onConflict:"id"}));
    return sendJson(res,existing?200:201,(await getNavigation()).find(x=>x.id===row.id));
  }catch(e){return sendJson(res,e.status||500,{error:e.status?e.message:"Could not save navigation item."});}
}
async function handleSkillWrite(req,res,id){
  try{
    const b=await readJson(req),name=String(b.name||"").trim();if(!name||name.length>60)return sendJson(res,400,{error:"Skill name must be 1-60 characters."});
    const percent=Number(b.percent??80);if(!Number.isInteger(percent)||percent<0||percent>100)return sendJson(res,400,{error:"Percent must be an integer from 0 to 100."});
    const icon=String(b.icon||"ri-star-line").trim();if(!/^ri-[a-z0-9-]+$/.test(icon))return sendJson(res,400,{error:"Icon must match the pattern ri-<name>."});
    const row={id:id||crypto.randomUUID(),name,percent,icon,display_order:parseInt(b.displayOrder??0,10)||0,is_visible:boolValue(b.visible??true)};if(id&&!await one("skills",id))return sendJson(res,404,{error:"Skill not found."});
    await q(supabase.from("skills").upsert(row,{onConflict:"id"}));return sendJson(res,200,await getSkills());
  }catch(e){return sendJson(res,e.status||500,{error:e.status?e.message:"Could not save skill."});}
}
async function handleMediaEdit(req,res,id){
  try{const media=await one("media",id);if(!media)return sendJson(res,404,{error:"Media item not found."});const b=await readJson(req),fileName=String(b.fileName||"").trim(),altText=String(b.altText||"").trim();if(!fileName||fileName.length>255|/[\\/\r\n]/.test(fileName)||altText.length>1000)return sendJson(res,400,{error:"Provide a valid display filename and alt text."});
    const update={file_name:fileName,alt_text:altText};if(typeof b.aiMetadata==="string"||b.aiMetadata===null)update.ai_metadata=b.aiMetadata;await q(supabase.from("media").update(update).eq("id",id));return sendJson(res,200,await one("media",id));
  }catch(e){return sendJson(res,e.status||500,{error:e.status?e.message:"Could not update media details."});}
}
async function handleMediaReplace(req,res,id){
  try{
    const media=await one("media",id);if(!media)return sendJson(res,404,{error:"Media item not found."});
    const p=parseMultipart(await readBody(req),req.headers["content-type"]||""),photo=p.files.find(x=>x.name==="photo");if(!photo||!ALLOWED_IMAGE_TYPES.has(photo.type)||!isValidImage(photo.data,photo.type))return sendJson(res,415,{error:"Upload a valid JPEG, PNG, WebP, or AVIF image."});if(photo.data.length>MAX_UPLOAD_BYTES)return sendJson(res,413,{error:"Image exceeds the 12 MB limit."});
    const newPath=`portfolio/${id}${ALLOWED_IMAGE_TYPES.get(photo.type)}`,url=await storageUpload(newPath,photo.data,photo.type);await q(supabase.from("media").update({file_name:photo.filename,file_url:url,mime_type:photo.type}).eq("id",id));
    const oldPath=storagePathFromUrl(media.file_url);if(oldPath&&oldPath!==newPath)await storageDelete(oldPath);return sendJson(res,200,{id,fileName:photo.filename,fileUrl:url,mimeType:photo.type});
  }catch(e){return sendJson(res,e.status||500,{error:e.status?e.message:"Could not replace media file."});}
}
async function handleAiAnalyze(req,res){
  try{
    const session=getSession(req);if(!session)return sendJson(res,401,{error:"Authentication required."});const last=aiAnalysisCooldowns.get(session.key)||0;if(Date.now()-last<5000)return sendJson(res,429,{error:"Please wait before analyzing again."});
    const b=await readJson(req),media=await one("media",String(b.mediaId||""));if(!media)return sendJson(res,404,{error:"Media item not found."});
    const source=storagePathFromUrl(media.file_url);if(!source)return sendJson(res,400,{error:"Cannot resolve stored image."});
    const tmp=path.join(os.tmpdir(),`photo-${crypto.randomUUID()}${path.extname(source)}`);const downloaded=await supabase.storage.from(STORAGE_BUCKET).download(source);if(downloaded.error)throw dbError(downloaded.error);fs.writeFileSync(tmp,Buffer.from(await downloaded.data.arrayBuffer()));
    aiAnalysisCooldowns.set(session.key,Date.now());try{return sendJson(res,200,await analyzePhoto(tmp,media.mime_type));}finally{fs.rmSync(tmp,{force:true});}
  }catch(e){return sendJson(res,e.status||500,{error:e.status?e.message:"AI analysis failed unexpectedly."});}
}
async function handleAdminApi(req,res,url){
  const p=url.pathname;
  if(p==="/api/auth/session"&&req.method==="GET"){const s=getSession(req);return sendJson(res,200,{authenticated:Boolean(s),username:s?.session.username||null});}
  if(p==="/api/auth/login"&&req.method==="POST"){
    const ip=req.socket.remoteAddress||"unknown",a=loginAttempts.get(ip)||{count:0,until:Date.now()+900000};if(a.until<Date.now()){a.count=0;a.until=Date.now()+900000;}if(a.count>=8)return sendJson(res,429,{error:"Too many login attempts. Try again later."});
    try{const {username,password}=await readJson(req),u=String(username||"").trim().toLowerCase(),configured=String(process.env.ADMIN_USERNAME).trim().toLowerCase(),userOk=u===configured||u.replace(",",".")===configured.replace(",",".");const salt=process.env.ADMIN_PASSWORD_SALT||"local-cms-install",expected=crypto.scryptSync(process.env.ADMIN_PASSWORD,salt,64),actual=crypto.scryptSync(String(password||""),salt,64),passOk=crypto.timingSafeEqual(expected,actual);if(!userOk||!passOk){a.count++;loginAttempts.set(ip,a);return sendJson(res,401,{error:"Username or password is incorrect."});}loginAttempts.delete(ip);const token=createSessionToken(process.env.ADMIN_USERNAME);return sendJson(res,200,{authenticated:true,username:process.env.ADMIN_USERNAME},{"Set-Cookie":`${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL/1000}${isSecureRequest(req)?"; Secure":""}`});}catch(e){return sendJson(res,400,{error:e.message});}
  }
  if(p==="/api/auth/logout"&&req.method==="POST")return sendJson(res,200,{authenticated:false},{"Set-Cookie":`${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isSecureRequest(req)?"; Secure":""}`});
  if(!p.startsWith("/api/admin/"))return null;if(!requireAdmin(req,res))return true;
  try{
    if(p==="/api/admin/dashboard"&&req.method==="GET"){const [items,skills,social,nav]=await Promise.all([q(supabase.from("portfolio_items").select("id,is_published,is_hidden,is_featured")),q(supabase.from("skills").select("id")),q(supabase.from("social_links").select("id")),q(supabase.from("navigation_items").select("id"))]);return sendJson(res,200,{totalPhotos:items.length,publishedPhotos:items.filter(x=>x.is_published&&!x.is_hidden).length,draftPhotos:items.filter(x=>!x.is_published).length,featuredPhotos:items.filter(x=>x.is_featured).length,skills:skills.length,socialLinks:social.length,navigationItems:nav.length});}
    if(p==="/api/admin/portfolio"&&req.method==="GET")return sendJson(res,200,await getPortfolioItems());
    if(p==="/api/admin/portfolio"&&req.method==="POST")return handlePortfolioWrite(req,res,null);
    let m=p.match(/^\/api\/admin\/portfolio\/([a-f0-9-]+)$/i);if(m&&req.method==="PUT")return handlePortfolioWrite(req,res,m[1]);if(m&&req.method==="DELETE")return handlePortfolioDelete(res,m[1]);
    if(p==="/api/admin/sections"&&req.method==="GET")return sendJson(res,200,await getSections());if(p==="/api/admin/sections"&&req.method==="POST")return handleSectionWrite(req,res,null);m=p.match(/^\/api\/admin\/sections\/([a-z0-9-]+)$/i);if(m&&req.method==="PUT")return handleSectionWrite(req,res,m[1]);if(m&&req.method==="DELETE")return handleSectionDelete(res,m[1]);
    if(p==="/api/admin/content"&&req.method==="GET")return sendJson(res,200,await getContent());if(p==="/api/admin/content"&&req.method==="PUT")return handleContentWrite(req,res);
    if(p==="/api/admin/social"&&req.method==="GET")return sendJson(res,200,await getSocialLinks());if(p==="/api/admin/social"&&req.method==="POST")return handleSocialWrite(req,res,null);m=p.match(/^\/api\/admin\/social\/([a-z0-9-]+)$/i);if(m&&req.method==="PUT")return handleSocialWrite(req,res,m[1]);if(m&&req.method==="DELETE"){await q(supabase.from("social_links").delete().eq("id",m[1]));return sendJson(res,200,{deleted:true});}
    if(p==="/api/admin/navigation"&&req.method==="GET")return sendJson(res,200,await getNavigation());if(p==="/api/admin/navigation"&&req.method==="POST")return handleNavigationWrite(req,res,null);m=p.match(/^\/api\/admin\/navigation\/([a-z0-9-]+)$/i);if(m&&req.method==="PUT")return handleNavigationWrite(req,res,m[1]);if(m&&req.method==="DELETE"){await q(supabase.from("navigation_items").delete().eq("id",m[1]));return sendJson(res,200,{deleted:true});}
    if(p==="/api/admin/media"&&req.method==="GET"){const media=await q(supabase.from("media").select("*").order("created_at",{ascending:false}));const usage=await Promise.all(media.map(async x=>({x,u:await mediaUsage(x.id)})));return sendJson(res,200,usage.map(({x,u})=>({...x,usage:u})));}
    m=p.match(/^\/api\/admin\/media\/([a-f0-9-]+)$/i);if(m&&req.method==="GET"){const media=await one("media",m[1]);if(!media)return sendJson(res,404,{error:"Media item not found."});return sendJson(res,200,{...media,usage:await mediaUsage(m[1])});}if(m&&req.method==="DELETE")return handleMediaDelete(res,m[1],url.searchParams.get("mode"));if(m&&req.method==="PATCH")return handleMediaEdit(req,res,m[1]);if(m&&req.method==="PUT")return handleMediaReplace(req,res,m[1]);
    if(p==="/api/admin/ai/analyze-photo"&&req.method==="POST")return handleAiAnalyze(req,res);
    if(p==="/api/admin/skills"&&req.method==="GET")return sendJson(res,200,await getSkills());if(p==="/api/admin/skills"&&req.method==="POST")return handleSkillWrite(req,res,null);m=p.match(/^\/api\/admin\/skills\/([a-z0-9-]+)$/i);if(m&&req.method==="PUT")return handleSkillWrite(req,res,m[1]);if(m&&req.method==="DELETE"){const ex=await one("skills",m[1]);if(!ex)return sendJson(res,404,{error:"Skill not found."});await q(supabase.from("skills").delete().eq("id",m[1]));return sendJson(res,200,{deleted:true});}
    return sendJson(res,404,{error:"Admin API route not found."});
  }catch(e){console.error(e);return sendJson(res,e.status||500,{error:e.status?e.message:"The server could not complete the request."});}
}
function serveStatic(req,res,url){
  const pathname=decodeURIComponent(url.pathname),clean=pathname.length>1?pathname.replace(/\/+$/,""):pathname;
  const adminRoutes=new Set(["/admin","/admin/login","/admin/dashboard","/admin/portfolio","/admin/content","/admin/skills","/admin/social","/admin/navigation","/admin/media","/admin/settings"]);
  if(adminRoutes.has(clean)){const file=fs.readFileSync(path.join(ROOT,"admin","admin.html"));res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});return res.end(file);}
  const aliases={"/about":"about.html","/portfolio":"photography.html","/contact":"hire.html"},relative=pathname==="/"?"home.html":aliases[pathname]||pathname.slice(1);
  const first=relative.split(/[\\/]/,1)[0].toLowerCase();if(first===".git"||first==="data"||first==="node_modules"||relative.toLowerCase()===".env"||relative.toLowerCase()==="javascript/server.js"){res.writeHead(404);return res.end("Not found");}
  const target=path.resolve(ROOT,relative);if(!target.startsWith(ROOT+path.sep)){res.writeHead(403);return res.end("Forbidden");}if(!fs.existsSync(target)||!fs.statSync(target).isFile()){res.writeHead(404);return res.end("Not found");}
  const type=MIME_BY_EXTENSION.get(path.extname(target).toLowerCase())||"application/octet-stream";res.writeHead(200,{"Content-Type":type,"X-Content-Type-Options":"nosniff","Cache-Control":type.startsWith("image/")?"public, max-age=86400":"no-cache"});return fs.createReadStream(target).pipe(res);
}
async function requestHandler(req,res){
  const raw=req.headers["x-forwarded-uri"]||req.headers["x-matched-path"]||req.url,url=new URL(raw,`http://${req.headers.host||"localhost"}`);
  if(req.method==="GET"&&url.pathname==="/api/public/site"){
    const sections=(await getSections()).filter(x=>x.visible),items=await getPortfolioItems({publicOnly:true}),photos={};for(const s of sections)photos[s.slug]=items.filter(x=>x.sections.includes(s.slug));
    return sendJson(res,200,{content:await getContent(),navigation:(await getNavigation()).filter(x=>x.visible),sections,photos,socialLinks:(await getSocialLinks()).filter(x=>x.visible),skills:await getSkills({visibleOnly:true})});
  }
  if(url.pathname.startsWith("/api/")&&req.method!=="GET"&&!checkOrigin(req,res))return;
  const handled=await handleAdminApi(req,res,url);if(handled)return;
  if(url.pathname.startsWith("/api/"))return sendJson(res,404,{error:"API route not found."});
  if(req.method!=="GET"&&req.method!=="HEAD"){res.writeHead(405,{Allow:"GET, HEAD"});return res.end("Method not allowed");}
  return serveStatic(req,res,url);
}
const server=http.createServer((req,res)=>requestHandler(req,res).catch(e=>{console.error(e);if(!res.headersSent)sendJson(res,e.status||500,{error:"The server could not complete the request."});else res.destroy();}));
if(!IS_VERCEL&&require.main===module)server.listen(PORT,()=>console.log(`Photography portfolio CMS running at http://localhost:${PORT}`));
module.exports={requestHandler,server};
