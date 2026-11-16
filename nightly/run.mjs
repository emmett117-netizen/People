// Nightly People job for GitHub Actions.
// Reuses the app's own note-editing code (read from index.html) so the phone app and this job behave the same.
// Logs print counts only: this repository is public, so no names, emails or numbers ever go to the log.
import {readFileSync} from 'node:fs';

const env = process.env;
const need = k => { if (!env[k]) { console.error(`Missing ${k}`); process.exit(2); } return env[k]; };
const CLIENT_ID = need('GOOGLE_CLIENT_ID'), CLIENT_SECRET = need('GOOGLE_CLIENT_SECRET'), REFRESH = need('GOOGLE_REFRESH_TOKEN');
const VAULT = need('VAULT_FOLDER_ID');
const CONTACTS_ON = String(env.CONTACTS_SYNC || '').toLowerCase() === 'on';
const DRY = String(env.DRY_RUN || '') === '1';
const G = env.GOOGLE_API_BASE || 'https://www.googleapis.com', P = env.PEOPLE_API_BASE || 'https://people.googleapis.com', TOKEN_URL = env.OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token';

// --- pull the shared functions out of the app ---
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const src = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
// The app's code is laid out one top-level declaration per line, with continuation lines indented,
// so a declaration runs from its first line up to the next line that starts at column 0.
function extract(name) {
  const lines = src.split('\n');
  const re = new RegExp('^((async )?function ' + name + '\\(|const ' + name + '=)');
  const at = lines.findIndex(l => re.test(l)); if (at < 0) throw new Error('app function not found: ' + name);
  let end = at + 1; while (end < lines.length && /^\s/.test(lines[end]) && lines[end].trim()) end++;
  return lines.slice(at, end).join('\n');
}
const names = ['parseVal','parseNote','setField','addLog','applyOps','noteTemplate','addToSection','connectionsPart','addConn','dropConn',
  'applyClaudeUpdates','markInboxDone','digits10','vaultBasics','contactsPlan','contactBody','contactsPush'];
let token = null;
const shim = `
let people=[];const S={};const ui={};const LS={get:(k,d)=>d,set:()=>{}};const save=()=>{};const toast=()=>{};
const VAULT_ID=${JSON.stringify(VAULT)};const DR=${JSON.stringify(G + '/drive/v3/files')};const UP=${JSON.stringify(G + '/upload/drive/v3/files')};const PPL=${JSON.stringify(P + '/v1')};
const UPD_FOLDER='Claude updates';const INBOX='Voice inbox.md';
const arr=v=>Array.isArray(v)?v:(v?[v]:[]);
const today=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10)};
const view=p=>{const md=applyOps(p.md,p.ops);const r=parseNote(md);return{md,fm:r.fm,body:r.body}};
const F=(p,k)=>{const v=view(p).fm[k];return v==null?'':v};
const byName=n=>{n=String(n).normalize('NFC').toLowerCase();return people.find(p=>p.name.toLowerCase()===n)||null};
let folderIdCache=null;async function folderId(){return folderIdCache}
async function createOne(p){const meta={name:p.file,parents:[folderIdCache],mimeType:'text/markdown'};const b='x'+Date.now();
  const body='--'+b+'\\r\\nContent-Type: application/json\\r\\n\\r\\n'+JSON.stringify(meta)+'\\r\\n--'+b+'\\r\\nContent-Type: text/markdown\\r\\n\\r\\n'+applyOps(p.md,p.ops)+'\\r\\n--'+b+'--';
  const j=await(await api(UP+'?uploadType=multipart&fields=id,modifiedTime',{method:'POST',headers:{'Content-Type':'multipart/related; boundary='+b},body})).json();p.id=j.id;p.md=applyOps(p.md,p.ops);p.ops=[]}
`;
const code = (shim + names.map(extract).join('\n')).split('https://www.googleapis.com').join(G)
  + `\nreturn {setPeople:x=>{people=x},getPeople:()=>people,setFolder:x=>{folderIdCache=x},${names.join(',')},F,view,byName,S};`;
let api;
const lib = new Function('api', code)((...a) => api(...a));

// --- Google access ---
async function getToken() {
  const r = await fetch(TOKEN_URL, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH, grant_type: 'refresh_token'})});
  if (!r.ok) throw new Error('Google sign-in failed (' + r.status + '). The refresh token may have expired.');
  token = (await r.json()).access_token;
}
let writes = 0;
api = async (url, opt = {}) => {
  const method = (opt.method || 'GET').toUpperCase();
  if (DRY && method !== 'GET') { writes++; return new Response(JSON.stringify({id: 'dry', modifiedTime: new Date().toISOString(), createdPeople: []}), {status: 200}); }
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {...opt, headers: {Authorization: 'Bearer ' + token, ...(opt.headers || {})}});
    if ((r.status === 429 || r.status >= 500) && attempt < 4) { await new Promise(s => setTimeout(s, 1500 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error(`Google error ${r.status} on ${method} ${new URL(url).pathname.split('/').slice(0, 4).join('/')}`);
    if (method !== 'GET') writes++;
    return r;
  }
};
const DR = G + '/drive/v3/files', UP = G + '/upload/drive/v3/files';
const q = s => encodeURIComponent(s);
async function list(query, fields = 'files(id,name,modifiedTime)') {
  let out = [], pt = '';
  do { const j = await (await api(`${DR}?q=${q(query)}&fields=nextPageToken,${fields}&pageSize=1000${pt ? '&pageToken=' + pt : ''}`)).json(); out = out.concat(j.files || []); pt = j.nextPageToken || ''; } while (pt);
  return out;
}
const putNote = async (p, md) => { await api(`${UP}/${p.id}?uploadType=media`, {method: 'PATCH', headers: {'Content-Type': 'text/markdown'}, body: md}); p.md = md; };

// --- tidy-up: mirror one-sided connections ---
const MIRROR = l => { const x = l.toLowerCase();
  if (/^(mother|father|mom|dad|parent)$/.test(x)) return 'Child';
  if (/^(son|daughter|child|kid)$/.test(x)) return 'Parent';
  if (/^(brother|sister|sibling)$/.test(x)) return 'Sibling';
  if (/^(wife|husband|spouse)$/.test(x)) return 'Spouse';
  return l || 'Connected to'; };
function connLines(md) {
  const part = lib.connectionsPart(md), out = [];
  for (const line of part.split('\n')) { const m = line.match(/^\s*-\s*(?:([^:\[]+):\s*)?(.*)$/); if (!m) continue;
    const label = (m[1] || '').trim(); if (/same emails|group texts/i.test(label)) continue;
    for (const x of m[2].matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) out.push({label, name: x[1]}); }
  return out;
}

async function main() {
  await getToken();
  const folders = await list(`'${VAULT}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'files(id,name)');
  const peopleFolder = folders.find(f => f.name === 'People'); if (!peopleFolder) throw new Error('No People folder in the vault');
  lib.setFolder(peopleFolder.id);
  const files = (await list(`'${peopleFolder.id}' in parents and trashed=false`)).filter(f => /\.md$/i.test(f.name));
  const people = []; let i = 0;
  await Promise.all(Array.from({length: 8}, async () => { while (i < files.length) { const f = files[i++];
    const md = await (await api(`${DR}/${f.id}?alt=media`)).text();
    people.push({id: f.id, file: f.name, name: f.name.normalize('NFC').replace(/\.md$/i, ''), md, ops: []}); } }));
  people.sort((a, b) => a.name.localeCompare(b.name)); lib.setPeople(people);
  const report = {date: new Date().toISOString(), people: people.length, applied: 0, mirrored: [], broken: [], dupPhones: [], contacts: null, errors: []};

  // 1. update files Claude left in the vault
  try { report.applied = await lib.applyClaudeUpdates(); } catch (e) { report.errors.push('updates: ' + e.message); }

  // 2. one-sided connections
  const all = lib.getPeople(), byN = new Map(all.map(p => [p.name.toLowerCase(), p]));
  const add = new Map();
  for (const a of all) for (const c of connLines(a.md)) {
    const b = byN.get(c.name.toLowerCase());
    if (!b) { report.broken.push(`${a.name} → [[${c.name}]]`); continue; }
    if (b === a || lib.connectionsPart(b.md).includes('[[' + a.name + ']]') || lib.connectionsPart(b.md).includes('[[' + a.name + '|')) continue;
    const list = add.get(b) || []; if (!list.some(x => x.to === a.name)) list.push({label: MIRROR(c.label), to: a.name}); add.set(b, list);
  }
  for (const [b, list] of add) { try { let md = b.md; for (const x of list) { md = lib.addConn(md, x.label, x.to); report.mirrored.push(`${b.name}: ${x.label} → ${x.to}`); } await putNote(b, md); } catch (e) { report.errors.push('mirror: ' + e.message); } }

  // 3. the same phone number on more than one person
  const seen = new Map();
  for (const p of all) for (const n of lib.vaultBasics(p).phones) { const k = lib.digits10(n); if (k.length < 10) continue; (seen.get(k) || seen.set(k, []).get(k)).push(p.name); }
  for (const [, ns] of seen) { const u = [...new Set(ns)]; if (u.length > 1) report.dupPhones.push(u.join(' / ')); }

  // 4. Google Contacts
  if (CONTACTS_ON) { try { const plan = await lib.contactsPlan(); const n = plan.length ? await lib.contactsPush(plan) : 0;
      report.contacts = {created: plan.filter(x => x.kind === 'create').length, updated: plan.filter(x => x.kind === 'update').length, done: n, details: plan.map(x => `${x.name}: ${x.what.join('; ')}`)};
    } catch (e) { report.errors.push('contacts: ' + e.message); } }

  // 5. report into the vault (private), counts to the log (public)
  const md = `# People nightly report\n\nLast run: ${report.date}\n\n` +
    `- People: ${report.people}\n- Claude updates applied: ${report.applied}\n- One-sided connections fixed: ${report.mirrored.length}\n` +
    `- Google Contacts: ${report.contacts ? `${report.contacts.created} created, ${report.contacts.updated} updated` : 'off'}\n` +
    (report.errors.length ? `\n## Problems\n${report.errors.map(e => '- ' + e).join('\n')}\n` : '') +
    (report.mirrored.length ? `\n## Connections fixed\n${report.mirrored.map(e => '- ' + e).join('\n')}\n` : '') +
    (report.broken.length ? `\n## Links to people with no note\n${[...new Set(report.broken)].map(e => '- ' + e).join('\n')}\n` : '') +
    (report.dupPhones.length ? `\n## Same phone number on more than one person\n${report.dupPhones.map(e => '- ' + e).join('\n')}\n` : '') +
    (report.contacts && report.contacts.details.length ? `\n## Google Contacts changes\n${report.contacts.details.map(e => '- ' + e).join('\n')}\n` : '');
  const rf = (await list(`name='People report.md' and '${VAULT}' in parents and trashed=false`))[0];
  if (rf) await api(`${UP}/${rf.id}?uploadType=media`, {method: 'PATCH', headers: {'Content-Type': 'text/markdown'}, body: md});
  else { const b = 'x' + Date.now(); await api(`${UP}?uploadType=multipart`, {method: 'POST', headers: {'Content-Type': 'multipart/related; boundary=' + b},
    body: `--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({name: 'People report.md', parents: [VAULT], mimeType: 'text/markdown'})}\r\n--${b}\r\nContent-Type: text/markdown\r\n\r\n${md}\r\n--${b}--`}); }
  console.log(`people=${report.people} updates_applied=${report.applied} connections_fixed=${report.mirrored.length} broken_links=${new Set(report.broken).size} shared_phones=${report.dupPhones.length} contacts=${report.contacts ? report.contacts.created + '+' + report.contacts.updated : 'off'} writes=${writes} problems=${report.errors.length}${DRY ? ' (dry run)' : ''}`);
  if (report.errors.length) process.exitCode = 1;
}
main().catch(e => { console.error('Nightly run failed: ' + e.message); process.exit(1); });
