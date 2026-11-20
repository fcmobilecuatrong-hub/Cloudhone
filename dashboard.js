// Dashboard tích hợp Render + Railway + GitHub.
// Gắn vào server: require('./dashboard')(app, panelAuth);
// Env cần: RENDER_API_KEY, RAILWAY_API_TOKEN (Account token), GITHUB_TOKEN, GITHUB_REPO (owner/repo)

module.exports = function mountDashboard(app, panelAuth) {
    const env = k => String(process.env[k] || '').trim();

    async function http(url, opts = {}) {
        const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        if (!res.ok) {
            const msg = (data && typeof data === 'object' && (data.message || data.error)) || `HTTP ${res.status}`;
            throw new Error(String(msg));
        }
        return data;
    }

    // ---------- Render ----------
    function render(path, opts = {}) {
        const key = env('RENDER_API_KEY');
        if (!key) throw new Error('Chưa đặt RENDER_API_KEY');
        return http('https://api.render.com/v1' + path, {
            ...opts,
            headers: { Authorization: 'Bearer ' + key, Accept: 'application/json', 'Content-Type': 'application/json' }
        });
    }
    async function renderOverview() {
        const list = await render('/services?limit=50');
        return Promise.all(list.map(async item => {
            const s = item.service || item;
            let deploy = null;
            try {
                const d = await render(`/services/${s.id}/deploys?limit=1`);
                if (d[0]) deploy = (d[0].deploy || d[0]);
            } catch {}
            const url = s.serviceDetails && s.serviceDetails.url;
            return {
                id: s.id, name: s.name, type: s.type,
                status: s.suspended === 'suspended' ? 'suspended' : (deploy ? deploy.status : 'unknown'),
                url: url ? (url.startsWith('http') ? url : 'https://' + url) : '',
                branch: s.branch || '', repo: s.repo || '',
                commit: deploy && deploy.commit ? String(deploy.commit.message || '').split('\n')[0] : '',
                at: deploy ? (deploy.finishedAt || deploy.createdAt) : s.updatedAt,
                dash: s.dashboardUrl || `https://dashboard.render.com/web/${s.id}`
            };
        }));
    }

    // ---------- Railway ----------
    async function gql(query, variables) {
        const token = env('RAILWAY_API_TOKEN');
        if (!token) throw new Error('Chưa đặt RAILWAY_API_TOKEN');
        const data = await http('https://backboard.railway.com/graphql/v2', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables })
        });
        if (data.errors && data.errors.length) throw new Error(data.errors[0].message || 'Railway GraphQL lỗi');
        return data.data;
    }
    async function railwayOverview() {
        const FIELDS = `id name
            environments { edges { node { id name } } }
            services { edges { node { id name } } }`;
        // Thử lần lượt nhiều cách lấy project (token tài khoản / workspace nhóm / project token)
        const attempts = [
            [`query { projects { edges { node { ${FIELDS} } } } }`, d => d.projects],
            [`query { me { projects { edges { node { ${FIELDS} } } } } }`, d => d.me && d.me.projects],
            [`query { me { workspaces { projects { edges { node { ${FIELDS} } } } } } }`,
                d => ({ edges: ((d.me && d.me.workspaces) || []).flatMap(w => (w.projects && w.projects.edges) || []) })],
            [`query { projectToken { project { ${FIELDS} } } }`,
                d => d.projectToken && d.projectToken.project ? { edges: [{ node: d.projectToken.project }] } : null]
        ];
        const found = new Map();
        const errors = [];
        for (const [q, pick] of attempts) {
            try {
                const conn = pick(await gql(q));
                for (const e of (conn && conn.edges) || []) if (e && e.node) found.set(e.node.id, e.node);
            } catch (e) { errors.push(e.message); }
        }
        const projects = [...found.values()];
        if (!projects.length && errors.length) throw new Error('Không lấy được project Railway: ' + errors[0]);
        const out = [];
        await Promise.all(projects.map(async p => {
            const envs = p.environments.edges.map(e => e.node);
            const environment = envs.find(e => e.name === 'production') || envs[0];
            if (!environment) return;
            await Promise.all(p.services.edges.map(async se => {
                const svc = se.node;
                let dep = null;
                try {
                    const r = await gql(`query($p:String!,$s:String!,$e:String!){
                        deployments(first:1, input:{projectId:$p, serviceId:$s, environmentId:$e}){
                            edges{node{id status createdAt staticUrl}}}}`,
                        { p: p.id, s: svc.id, e: environment.id });
                    dep = r.deployments.edges[0] && r.deployments.edges[0].node;
                } catch {}
                out.push({
                    id: svc.id, name: svc.name, project: p.name, projectId: p.id,
                    environmentId: environment.id, environment: environment.name,
                    status: dep ? dep.status : 'unknown',
                    url: dep && dep.staticUrl ? 'https://' + dep.staticUrl : '',
                    at: dep ? dep.createdAt : null,
                    dash: `https://railway.com/project/${p.id}/service/${svc.id}`
                });
            }));
        }));
        return out.sort((a, b) => (a.project + a.name).localeCompare(b.project + b.name));
    }

    // ---------- GitHub ----------
    function gh(path, opts = {}) {
        const token = env('GITHUB_TOKEN');
        const repo = env('GITHUB_REPO');
        if (!token) throw new Error('Chưa đặt GITHUB_TOKEN');
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_REPO phải dạng owner/repo');
        return http(`https://api.github.com/repos/${repo}${path}`, {
            ...opts,
            headers: {
                Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'nigaria-dashboard'
            }
        });
    }
    async function githubOverview() {
        const [info, commits, runs, pulls] = await Promise.all([
            gh(''), gh('/commits?per_page=8'),
            gh('/actions/runs?per_page=6').catch(() => ({ workflow_runs: [] })),
            gh('/pulls?state=open&per_page=6')
        ]);
        return {
            repo: info.full_name, url: info.html_url, branch: info.default_branch,
            stars: info.stargazers_count, issues: info.open_issues_count, private: info.private,
            pushedAt: info.pushed_at,
            commits: commits.map(c => ({
                sha: c.sha.slice(0, 7), url: c.html_url,
                msg: String(c.commit.message).split('\n')[0],
                author: (c.author && c.author.login) || c.commit.author.name, at: c.commit.author.date
            })),
            runs: (runs.workflow_runs || []).map(r => ({
                id: r.id, name: r.name, branch: r.head_branch, url: r.html_url,
                status: r.status === 'completed' ? r.conclusion : r.status, at: r.created_at
            })),
            pulls: pulls.map(p => ({ n: p.number, title: p.title, url: p.html_url, user: p.user.login, at: p.created_at }))
        };
    }

    const settle = p => Promise.resolve().then(() => p()).then(data => ({ ok: true, data }), e => ({ ok: false, error: e.message }));

    // ---------- Routes ----------
    app.get('/dashboard', (req, res) => res.type('html').send(DASH_HTML));

    app.get('/dash/api/overview', panelAuth, async (req, res) => {
        const [r, rw, g] = await Promise.all([settle(renderOverview), settle(railwayOverview), settle(githubOverview)]);
        res.json({ render: r, railway: rw, github: g, at: Date.now() });
    });

    app.post('/dash/api/render/:id/deploy', panelAuth, async (req, res) => {
        if (!/^srv-[a-z0-9]+$/i.test(req.params.id)) return res.status(400).json({ error: 'ID không hợp lệ' });
        try { await render(`/services/${req.params.id}/deploys`, { method: 'POST', body: '{}' }); res.json({ ok: true }); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post('/dash/api/railway/redeploy', panelAuth, async (req, res) => {
        const { serviceId, environmentId } = req.body || {};
        const uuid = /^[0-9a-f-]{36}$/i;
        if (!uuid.test(String(serviceId)) || !uuid.test(String(environmentId))) return res.status(400).json({ error: 'ID không hợp lệ' });
        try {
            await gql(`mutation($s:String!,$e:String!){ serviceInstanceRedeploy(serviceId:$s, environmentId:$e) }`,
                { s: serviceId, e: environmentId });
            res.json({ ok: true });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post('/dash/api/github/rerun/:runId', panelAuth, async (req, res) => {
        if (!/^\d+$/.test(req.params.runId)) return res.status(400).json({ error: 'ID không hợp lệ' });
        try { await gh(`/actions/runs/${req.params.runId}/rerun`, { method: 'POST' }); res.json({ ok: true }); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
};

const DASH_HTML = String.raw`<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0e0f1c">
<title>Dashboard triển khai</title>
<style>
:root{--bg:#0e0f1c;--sf:#171830;--ln:#26284a;--tx:#eceeff;--mut:#8a8fb8;--ok:#5ee6a8;--ac:#6b78ff;--bad:#ff7a90;--warn:#ffd60a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:22px 16px 80px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px}
h1{margin:0;font-size:24px;letter-spacing:-.02em}
.sub{color:var(--mut);font-size:13px;margin-top:2px}
.row{display:flex;gap:8px;align-items:center}
.ghost{background:none;border:1px solid var(--ln);color:var(--mut);border-radius:10px;padding:8px 12px;font:inherit;font-size:13px;cursor:pointer}
.ghost:hover{color:var(--tx)}
.btn{border:0;border-radius:9px;padding:8px 12px;background:var(--ac);color:#fff;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.btn:disabled{opacity:.45;cursor:not-allowed}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:16px;align-items:start}
.col h2{font-size:13px;letter-spacing:.08em;color:var(--mut);margin:0 0 10px;text-transform:uppercase}
.card{background:var(--sf);border:1px solid var(--ln);border-radius:16px;padding:14px;margin-bottom:10px}
.t{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.m{color:var(--mut);font-size:12.5px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.m a,.t a{color:var(--ac);text-decoration:none}
.top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.chip{font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;border:1px solid;white-space:nowrap}
.ok{color:var(--ok);border-color:var(--ok)}.bad{color:var(--bad);border-color:var(--bad)}.warn{color:var(--warn);border-color:var(--warn)}.off{color:var(--mut);border-color:var(--mut)}
.acts{display:flex;gap:6px;margin-top:10px}
.err{background:#3a1a25;color:#ffc4cf;border-radius:12px;padding:12px;font-size:13px}
.stats{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--mut);margin-top:6px}
.stats b{color:var(--tx)}
h3{font-size:12px;color:var(--mut);margin:14px 0 6px;text-transform:uppercase;letter-spacing:.06em}
.li{padding:8px 0;border-top:1px solid var(--ln)}.li:first-of-type{border-top:0}
#login{display:none;max-width:380px;margin:14vh auto 0}
#login input{width:100%;padding:14px;border-radius:14px;border:1px solid var(--ln);background:var(--sf);color:var(--tx);font:inherit;margin:10px 0}
#app{display:none}
.toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,30px);background:#242650;padding:12px 18px;border-radius:14px;font-size:14px;opacity:0;pointer-events:none;transition:.25s;max-width:90vw}
.toast.show{opacity:1;transform:translate(-50%,0)}.toast.bad{background:#4a1d2b;color:#ffc4cf}
</style></head><body><div class="wrap">
<div id="login"><h1>Đăng nhập</h1><div class="sub">Dùng mật khẩu bảng điều khiển (PANEL_PASSWORD).</div>
<input id="pw" type="password" placeholder="Mật khẩu" autocomplete="current-password"><button class="btn" style="width:100%;padding:13px" onclick="doLogin()">Vào dashboard</button></div>
<div id="app"><header><div><h1>Dashboard triển khai</h1><div class="sub" id="stamp">Đang tải...</div></div>
<div class="row"><a class="ghost" href="/panel" style="text-decoration:none">Quản lý bot</a><button class="ghost" onclick="load()">Làm mới</button><button class="ghost" onclick="logout()">Đăng xuất</button></div></header>
<div class="cols">
<div class="col"><h2>Render</h2><div id="render"></div></div>
<div class="col"><h2>Railway</h2><div id="railway"></div></div>
<div class="col"><h2>GitHub</h2><div id="github"></div></div>
</div></div></div><div class="toast" id="toast"></div>
<script>
var K=sessionStorage.getItem('k')||'';
function $(i){return document.getElementById(i)}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function toast(t,bad){var e=$('toast');e.textContent=t;e.className='toast show'+(bad?' bad':'');clearTimeout(window._t);window._t=setTimeout(function(){e.className='toast'},3200)}
function ago(d){if(!d)return '';var s=Math.max(0,(Date.now()-new Date(d).getTime())/1000);if(s<60)return 'vừa xong';if(s<3600)return Math.floor(s/60)+' phút trước';if(s<86400)return Math.floor(s/3600)+' giờ trước';return Math.floor(s/86400)+' ngày trước'}
function api(m,u,b){return fetch(u,{method:m,headers:{'Content-Type':'application/json','x-panel-key':K},body:b?JSON.stringify(b):undefined}).then(function(r){return r.json().catch(function(){return {}}).then(function(j){if(r.status===401){logout(true)}if(!r.ok)throw new Error(j.error||'Có lỗi xảy ra');return j})})}
function view(login){$('login').style.display=login?'block':'none';$('app').style.display=login?'none':'block'}
function logout(bad){K='';sessionStorage.removeItem('k');view(true);if(bad)toast('Sai mật khẩu',true)}
function doLogin(){K=$('pw').value;sessionStorage.setItem('k',K);load()}
$('pw').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin()});
var CH={live:['ok','LIVE'],success:['ok','LIVE'],deployed:['ok','LIVE'],active:['ok','LIVE'],completed:['ok','XONG'],
 build_in_progress:['warn','BUILD'],update_in_progress:['warn','DEPLOY'],created:['warn','CHỜ'],building:['warn','BUILD'],deploying:['warn','DEPLOY'],initializing:['warn','KHỞI TẠO'],queued:['warn','HÀNG CHỜ'],in_progress:['warn','CHẠY'],waiting:['warn','CHỜ'],
 build_failed:['bad','LỖI'],update_failed:['bad','LỖI'],failed:['bad','LỖI'],crashed:['bad','CRASH'],failure:['bad','LỖI'],timed_out:['bad','TIMEOUT'],
 canceled:['off','HỦY'],cancelled:['off','HỦY'],removed:['off','GỠ'],skipped:['off','BỎ QUA'],suspended:['off','TẠM DỪNG'],deactivated:['off','CŨ'],sleeping:['off','NGỦ']};
function chip(s){var k=String(s||'').toLowerCase();var c=CH[k]||['off',(s||'?').toString().toUpperCase()];return '<span class="chip '+c[0]+'">'+esc(c[1])+'</span>'}
function errBox(r){return '<div class="err">'+esc(r.error)+'</div>'}
function link(u,t){return u?'<a href="'+esc(u)+'" target="_blank" rel="noopener">'+esc(t)+'</a>':esc(t)}
function renderRender(r){
 if(!r.ok)return errBox(r);if(!r.data.length)return '<div class="m">Không có service</div>';
 return r.data.map(function(s){return '<div class="card"><div class="top"><div style="min-width:0"><div class="t">'+esc(s.name)+'</div><div class="m">'+esc(s.type)+(s.branch?' · '+esc(s.branch):'')+'</div></div>'+chip(s.status)+'</div>'
  +(s.commit?'<div class="m">'+esc(s.commit)+'</div>':'')+'<div class="m">'+ago(s.at)+(s.url?' · '+link(s.url,s.url.replace('https://','')):'')+'</div>'
  +'<div class="acts"><button class="btn" data-a="rdeploy" data-id="'+esc(s.id)+'" data-n="'+esc(s.name)+'">Deploy</button><a class="ghost" style="text-decoration:none" href="'+esc(s.dash)+'" target="_blank" rel="noopener">Log</a></div></div>'}).join('')}
function renderRailway(r){
 if(!r.ok)return errBox(r);if(!r.data.length)return '<div class="m">Không có service</div>';
 return r.data.map(function(s){return '<div class="card"><div class="top"><div style="min-width:0"><div class="t">'+esc(s.name)+'</div><div class="m">'+esc(s.project)+' · '+esc(s.environment)+'</div></div>'+chip(s.status)+'</div>'
  +'<div class="m">'+ago(s.at)+(s.url?' · '+link(s.url,s.url.replace('https://','')):'')+'</div>'
  +'<div class="acts"><button class="btn" data-a="rwdeploy" data-id="'+esc(s.id)+'" data-e="'+esc(s.environmentId)+'" data-n="'+esc(s.name)+'">Redeploy</button><a class="ghost" style="text-decoration:none" href="'+esc(s.dash)+'" target="_blank" rel="noopener">Log</a></div></div>'}).join('')}
function renderGithub(r){
 if(!r.ok)return errBox(r);var g=r.data;
 var h='<div class="card"><div class="t">'+link(g.url,g.repo)+(g.private?' 🔒':'')+'</div><div class="stats"><span>Nhánh <b>'+esc(g.branch)+'</b></span><span>⭐ <b>'+g.stars+'</b></span><span>Issue/PR mở <b>'+g.issues+'</b></span></div><div class="m">Push cuối '+ago(g.pushedAt)+'</div></div>';
 h+='<div class="card"><h3 style="margin-top:0">Commit mới</h3>'+g.commits.map(function(c){return '<div class="li"><div class="t">'+link(c.url,c.msg)+'</div><div class="m">'+esc(c.sha)+' · '+esc(c.author)+' · '+ago(c.at)+'</div></div>'}).join('')+'</div>';
 h+='<div class="card"><h3 style="margin-top:0">Actions</h3>'+(g.runs.length?g.runs.map(function(x){return '<div class="li"><div class="top"><div class="t" style="min-width:0">'+link(x.url,x.name)+'</div>'+chip(x.status)+'</div><div class="m">'+esc(x.branch)+' · '+ago(x.at)+'</div>'+(x.status==='failure'?'<div class="acts"><button class="btn" data-a="rerun" data-id="'+x.id+'">Chạy lại</button></div>':'')+'</div>'}).join(''):'<div class="m">Chưa có workflow</div>')+'</div>';
 h+='<div class="card"><h3 style="margin-top:0">Pull request mở</h3>'+(g.pulls.length?g.pulls.map(function(p){return '<div class="li"><div class="t">'+link(p.url,'#'+p.n+' '+p.title)+'</div><div class="m">'+esc(p.user)+' · '+ago(p.at)+'</div></div>'}).join(''):'<div class="m">Không có</div>')+'</div>';
 return h}
function load(){
 if(!K){view(true);return}
 api('GET','/dash/api/overview').then(function(d){
  view(false);
  $('render').innerHTML=renderRender(d.render);
  $('railway').innerHTML=renderRailway(d.railway);
  $('github').innerHTML=renderGithub(d.github);
  $('stamp').textContent='Cập nhật lúc '+new Date(d.at).toLocaleTimeString('vi-VN')+' · tự làm mới mỗi 30 giây';
 }).catch(function(e){toast(e.message,true)})}
document.addEventListener('click',function(ev){
 var b=ev.target.closest('button[data-a]');if(!b)return;
 var a=b.dataset.a,p,msg;
 if(a==='rdeploy'){if(!confirm('Deploy '+b.dataset.n+'?'))return;p=api('POST','/dash/api/render/'+b.dataset.id+'/deploy');msg='Đã gửi deploy Render'}
 else if(a==='rwdeploy'){if(!confirm('Redeploy '+b.dataset.n+'?'))return;p=api('POST','/dash/api/railway/redeploy',{serviceId:b.dataset.id,environmentId:b.dataset.e});msg='Đã gửi redeploy Railway'}
 else if(a==='rerun'){p=api('POST','/dash/api/github/rerun/'+b.dataset.id);msg='Đã chạy lại workflow'}
 else return;
 b.disabled=true;
 p.then(function(){toast(msg);setTimeout(load,2500)}).catch(function(e){toast(e.message,true)}).then(function(){b.disabled=false})});
load();setInterval(function(){if(K&&!document.hidden)load()},30000);
</script></body></html>`;
