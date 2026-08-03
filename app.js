/* ==========================================================
   ゲームログ - app.js
   - Supabase (Auth + Postgres) を使ったログイン / データ共有
   - IDは内部的に「id@users.gamelog-app.com」という架空メールに変換してSupabase Authに渡す
   - 自分のゲームは編集可、他人のゲームは閲覧のみ
========================================================== */
(function(){
'use strict';

const FAKE_EMAIL_DOMAIN = '@users.gamelog-app.com';
const STATUSES = [
  {key:'playing', label:'プレイ中', color:'var(--blue)'},
  {key:'cleared', label:'クリア', color:'var(--green)'},
  {key:'paused', label:'中断', color:'var(--gray)'},
  {key:'backlog', label:'積みゲー', color:'var(--accent)'}
];
const STATUS_MAP = Object.fromEntries(STATUSES.map(s=>[s.key,s]));

let sb;
let currentUser = null;        // { id, username, avatarUrl }
let viewingUserId = null;      // 今表示しているユーザーのid
let isOwnView = true;
let games = [];
let filterStatus = 'all';
let searchQuery = '';
let sortMode = 'new_desc';
let dataLoaded = false;
let authMode = 'login';        // 'login' | 'signup'
let viewableProfiles = new Map(); // id -> {id, username, avatar_url, bio}

const $ = (id) => document.getElementById(id);

/* ---------------- 初期化 ---------------- */
function initSupabase(){
  if(!window.SUPABASE_URL || window.SUPABASE_URL.includes('YOUR-PROJECT-ID')){
    document.body.innerHTML = `
      <div style="max-width:560px;margin:80px auto;padding:24px;font-family:sans-serif;line-height:1.7;">
        <h2>設定が必要です</h2>
        <p><code>config.js</code> に自分のSupabaseプロジェクトのURLとanonキーを設定してください。
        手順は README.md を確認してください。</p>
      </div>`;
    throw new Error('Supabase config missing');
  }
  sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
}

function initTheme(){
  const saved = localStorage.getItem('game-log:theme') || 'dark';
  applyTheme(saved);
  document.querySelectorAll('.theme-swatch').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      applyTheme(btn.dataset.theme);
      if(currentUser){
        await sb.from('profiles').update({theme: btn.dataset.theme}).eq('id', currentUser.id);
      }
    });
  });
}
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('game-log:theme', theme);
  document.querySelectorAll('.theme-swatch').forEach(btn=>{
    btn.classList.toggle('on', btn.dataset.theme===theme);
  });
}

function showToast(msg){
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2200);
}
function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

/* ---------------- 認証まわり ---------------- */
function usernameToEmail(id){
  return id.trim().toLowerCase().replace(/\s+/g,'') + FAKE_EMAIL_DOMAIN;
}

function setAuthMode(mode){
  authMode = mode;
  $('tabLogin').classList.toggle('on', mode==='login');
  $('tabSignup').classList.toggle('on', mode==='signup');
  $('authPwConfirmField').style.display = mode==='signup' ? 'block' : 'none';
  $('authSubmitBtn').textContent = mode==='login' ? 'ログイン' : 'アカウントを作成';
  $('loginHint').textContent = mode==='login'
    ? 'アカウントをまだ作っていない場合は「はじめて使う」から登録してください。'
    : 'IDは他の人には表示されます（メールアドレスは不要です）。';
  $('loginError').classList.add('hidden');
}
$('tabLogin').addEventListener('click', ()=>setAuthMode('login'));
$('tabSignup').addEventListener('click', ()=>setAuthMode('signup'));

$('authSubmitBtn').addEventListener('click', async ()=>{
  const id = $('authId').value.trim();
  const pw = $('authPw').value;
  const errEl = $('loginError');
  errEl.classList.add('hidden');

  if(!/^[a-zA-Z0-9_\-]{2,20}$/.test(id)){
    errEl.textContent = 'IDは半角英数字・_・- で2〜20文字にしてください';
    errEl.classList.remove('hidden');
    return;
  }
  if(pw.length < 6){
    errEl.textContent = 'パスワードは6文字以上にしてください';
    errEl.classList.remove('hidden');
    return;
  }

  $('authSubmitBtn').disabled = true;
  const email = usernameToEmail(id);

  try{
    if(authMode === 'login'){
      const {data, error} = await sb.auth.signInWithPassword({email, password: pw});
      if(error) throw error;
      await onLoggedIn(data.user);
    }else{
      const confirmPw = $('authPwConfirm').value;
      if(pw !== confirmPw){
        errEl.textContent = 'パスワードが一致しません';
        errEl.classList.remove('hidden');
        $('authSubmitBtn').disabled = false;
        return;
      }
      const {data, error} = await sb.auth.signUp({email, password: pw});
      if(error) throw error;
      if(!data.session){
        errEl.textContent = 'アカウントは作成されましたが、ログインに確認が必要な設定になっています。Supabaseの Authentication 設定で「Confirm email」をOFFにしてください。';
        errEl.classList.remove('hidden');
        $('authSubmitBtn').disabled = false;
        return;
      }
      const {error: profileError} = await sb.from('profiles').insert({id: data.user.id, username: id});
      if(profileError){
        if(profileError.code === '23505'){
          errEl.textContent = 'そのIDはすでに使われています';
        }else{
          errEl.textContent = 'プロフィール作成に失敗しました: ' + profileError.message;
        }
        errEl.classList.remove('hidden');
        $('authSubmitBtn').disabled = false;
        return;
      }
      await onLoggedIn(data.user, id);
    }
  }catch(e){
    errEl.textContent = translateAuthError(e.message);
    errEl.classList.remove('hidden');
  }
  $('authSubmitBtn').disabled = false;
});

function translateAuthError(msg){
  if(!msg) return 'エラーが発生しました';
  if(msg.includes('Invalid login credentials')) return 'IDまたはパスワードが正しくありません';
  if(msg.includes('User already registered')) return 'そのIDはすでに使われています';
  if(msg.includes('Password should be at least')) return 'パスワードは6文字以上にしてください';
  return msg;
}

async function onLoggedIn(authUser, knownUsername){
  const {data: profile} = await sb.from('profiles').select('username, avatar_url, bio, theme').eq('id', authUser.id).single();
  const username = knownUsername || (profile && profile.username) || authUser.email.replace(FAKE_EMAIL_DOMAIN,'');
  currentUser = {id: authUser.id, username, avatarUrl: profile ? profile.avatar_url : null, bio: profile ? profile.bio : ''};

  applyTheme((profile && profile.theme) || localStorage.getItem('game-log:theme') || 'dark');
  updateAvatarUI();

  $('loginScreen').classList.add('hidden');
  $('appScreen').classList.remove('hidden');
  $('currentUserLabel').textContent = currentUser.username;

  await loadViewableUsers();
  setViewingUser(currentUser.id);
}

function updateAvatarUI(){
  const img = $('avatarImg');
  const initial = $('avatarInitial');
  if(currentUser && currentUser.avatarUrl){
    img.src = currentUser.avatarUrl;
    img.classList.remove('hidden');
    initial.classList.add('hidden');
  }else{
    img.classList.add('hidden');
    initial.classList.remove('hidden');
    initial.textContent = currentUser ? currentUser.username.charAt(0).toUpperCase() : '';
  }
}

$('logoutBtn').addEventListener('click', async ()=>{
  await sb.auth.signOut();
  currentUser = null;
  $('appScreen').classList.add('hidden');
  $('loginScreen').classList.remove('hidden');
  $('authPw').value = '';
});

/* ---------------- ユーザー一覧 / 表示切り替え ---------------- */
async function loadViewableUsers(){
  // group_membersはRLSにより「自分の所属グループに関する行」しか見えないため、
  // フィルタなしでSELECTするだけで「自分と同じグループの人たち」が取得できる
  const {data: rows} = await sb.from('group_members').select('user_id');
  const ids = new Set([currentUser.id]);
  (rows||[]).forEach(r=>ids.add(r.user_id));
  const idList = Array.from(ids);

  const {data: profs, error} = await sb.from('profiles').select('id, username, avatar_url, bio').in('id', idList);
  const list = error ? [{id:currentUser.id, username:currentUser.username, avatar_url:currentUser.avatarUrl, bio:currentUser.bio}] : profs;

  viewableProfiles = new Map(list.map(p=>[p.id, p]));

  const select = $('userSelect');
  const others = list.filter(p=>p.id !== currentUser.id).sort((a,b)=>a.username.localeCompare(b.username,'ja'));
  select.innerHTML =
    `<option value="${currentUser.id}">自分（${escapeHtml(currentUser.username)}）</option>` +
    others.map(p=>`<option value="${p.id}">${escapeHtml(p.username)}</option>`).join('');
  select.value = currentUser.id;
}
$('userSelect').addEventListener('change', (e)=> setViewingUser(e.target.value));

function renderViewingProfile(userId){
  const prof = viewableProfiles.get(userId) || {username:'', avatar_url:null, bio:''};
  const img = $('viewingAvatarImg');
  const initial = $('viewingAvatarInitial');
  if(prof.avatar_url){
    img.src = prof.avatar_url;
    img.classList.remove('hidden');
    initial.classList.add('hidden');
  }else{
    img.classList.add('hidden');
    initial.classList.remove('hidden');
    initial.textContent = prof.username ? prof.username.charAt(0).toUpperCase() : '';
  }
  const bubble = $('viewingBio');
  const bio = (prof.bio || '').trim();
  bubble.textContent = bio || '自己紹介はまだ設定されていません';
  bubble.classList.toggle('empty', !bio);
}

function setViewingUser(userId){
  viewingUserId = userId;
  isOwnView = (userId === currentUser.id);
  $('readonlyBadge').classList.toggle('hidden', isOwnView);
  $('addBtn').classList.toggle('hidden', !isOwnView);
  $('importBtn').classList.toggle('hidden', !isOwnView);
  renderViewingProfile(userId);
  loadGames();
}

/* ---------------- ゲームデータ ---------------- */
async function loadGames(){
  dataLoaded = false;
  renderGrid();
  const {data, error} = await sb
    .from('games')
    .select('*')
    .eq('user_id', viewingUserId)
    .order('updated_at', {ascending:false});
  games = error ? [] : data.map(dbToGame);
  dataLoaded = true;
  renderTabs();
  renderStats();
  renderGrid();
  if(isOwnView) refreshPlatformOptions();
}

function refreshPlatformOptions(){
  const unique = Array.from(new Set(games.map(g=>g.platform).filter(Boolean)));
  const list = $('platformOptions');
  if(list) list.innerHTML = unique.map(p=>`<option value="${escapeHtml(p)}"></option>`).join('');
}

function dbToGame(row){
  return {
    id: row.id,
    title: row.title,
    platform: row.platform,
    status: row.status,
    rating: row.rating,
    hours: row.hours,
    year: row.play_year,
    comment: row.comment,
    coverUrl: row.cover_url,
    updatedAt: row.updated_at
  };
}

function renderTabs(){
  const counts = {all: games.length};
  STATUSES.forEach(s=>counts[s.key]=0);
  games.forEach(g=>{ if(counts[g.status]!==undefined) counts[g.status]++; });

  const tabs = [{key:'all', label:'すべて'}, ...STATUSES];
  $('statusTabs').innerHTML = tabs.map(t=>`
    <button class="tab ${filterStatus===t.key?'active':''}" data-status="${t.key}">
      ${t.label} (${counts[t.key]||0})
    </button>`).join('');
  $('statusTabs').querySelectorAll('.tab').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      filterStatus = btn.dataset.status;
      renderTabs();
      renderGrid();
    });
  });
}

function renderStats(){
  const total = games.length;
  const cleared = games.filter(g=>g.status==='cleared').length;
  const totalHours = games.reduce((sum,g)=>sum + (Number(g.hours)||0), 0);
  $('statStrip').innerHTML = `
    <div class="stat-chip"><span class="num">${total}</span><span class="lbl">記録数</span></div>
    <div class="stat-chip"><span class="num">${cleared}</span><span class="lbl">クリア</span></div>
    <div class="stat-chip"><span class="num">${totalHours}</span><span class="lbl">総時間</span></div>
  `;
}

function getFilteredSorted(){
  let list = games.slice();
  if(filterStatus !== 'all') list = list.filter(g=>g.status===filterStatus);
  if(searchQuery.trim()){
    const q = searchQuery.trim().toLowerCase();
    list = list.filter(g=>(g.title||'').toLowerCase().includes(q));
  }
  if(sortMode==='new_desc') list.sort((a,b)=> new Date(b.updatedAt||0) - new Date(a.updatedAt||0));
  else if(sortMode==='new_asc') list.sort((a,b)=> new Date(a.updatedAt||0) - new Date(b.updatedAt||0));
  else if(sortMode==='rating_desc') list.sort((a,b)=> (Number(b.rating)||0) - (Number(a.rating)||0));
  else if(sortMode==='rating_asc') list.sort((a,b)=> (Number(a.rating)||0) - (Number(b.rating)||0));
  else if(sortMode==='hours_desc') list.sort((a,b)=> (Number(b.hours)||0) - (Number(a.hours)||0));
  else if(sortMode==='hours_asc') list.sort((a,b)=> (Number(a.hours)||0) - (Number(b.hours)||0));
  else if(sortMode==='year_desc') list.sort((a,b)=> (Number(b.year)||0) - (Number(a.year)||0));
  else if(sortMode==='year_asc') list.sort((a,b)=> (Number(a.year)||0) - (Number(b.year)||0));
  else if(sortMode==='title_asc') list.sort((a,b)=> (a.title||'').localeCompare(b.title||'', 'ja'));
  else if(sortMode==='title_desc') list.sort((a,b)=> (b.title||'').localeCompare(a.title||'', 'ja'));
  return list;
}

function renderMeter(rating){
  let segs = '';
  for(let i=1;i<=5;i++) segs += `<div class="seg ${i<=rating?'filled':''}"></div>`;
  return `<div class="meter">${segs}</div>`;
}
function formatUpdated(iso){
  if(!iso) return '';
  const d = new Date(iso);
  const pad = (n)=>String(n).padStart(2,'0');
  return `更新: ${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderGrid(){
  const content = $('content');
  if(!dataLoaded){
    content.innerHTML = '<div class="loading">読み込み中...</div>';
    return;
  }
  const list = getFilteredSorted();

  if(games.length === 0){
    content.innerHTML = isOwnView ? `
      <div class="empty">
        <div class="icon">🎮</div>
        <h3>まだ記録がありません</h3>
        <p>プレイしたゲームを追加して、記録を始めましょう。</p>
        <button class="add-btn" onclick="openModal()">＋ 最初のゲームを追加</button>
      </div>` : `
      <div class="empty">
        <div class="icon">📭</div>
        <h3>まだ記録がありません</h3>
        <p>このユーザーはまだゲームを記録していません。</p>
      </div>`;
    return;
  }
  if(list.length === 0){
    content.innerHTML = `
      <div class="empty">
        <div class="icon">🔍</div>
        <h3>該当するゲームがありません</h3>
        <p>検索条件やフィルターを変更してみてください。</p>
      </div>`;
    return;
  }

  content.innerHTML = `<div class="grid">${list.map(cardHtml).join('')}</div>`;
  content.querySelectorAll('.card').forEach(el=>{
    el.addEventListener('click', ()=>{
      const g = games.find(x=>x.id===el.dataset.id);
      if(isOwnView) openModal(g.id); else openViewModal(g);
    });
  });
}

function cardHtml(g){
  const st = STATUS_MAP[g.status] || STATUSES[3];
  return `
    <div class="card" style="--status-color:${st.color}" data-id="${g.id}">
      <div class="card-updated">${formatUpdated(g.updatedAt)}</div>
      ${g.coverUrl ? `<img class="card-cover" src="${escapeHtml(g.coverUrl)}" alt="" loading="lazy">` : ''}
      <div class="card-top">
        <h3 class="card-title">${escapeHtml(g.title)}</h3>
        ${g.platform ? `<span class="platform-badge">${escapeHtml(g.platform)}</span>` : ''}
      </div>
      <div class="status-line">
        <span class="status-dot" style="background:${st.color}"></span>
        <span class="status-text">${st.label}</span>
      </div>
      ${renderMeter(Number(g.rating)||0)}
      ${g.comment ? `<p class="card-comment">${escapeHtml(g.comment)}</p>` : ''}
      <div class="card-footer">
        <span>${g.hours ? g.hours+'h' : '--'}</span>
        <span>${g.year ? g.year+'年' : '年未記入'}</span>
      </div>
    </div>`;
}

/* ---------------- 読み取り専用モーダル（他人の記録） ---------------- */
function openViewModal(g){
  const st = STATUS_MAP[g.status] || STATUSES[3];
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="card-updated">${formatUpdated(g.updatedAt)}</div>
      <h2>${escapeHtml(g.title)}</h2>
      ${g.coverUrl ? `<img class="card-cover" src="${escapeHtml(g.coverUrl)}" alt="" style="aspect-ratio:auto; max-height:280px; object-fit:contain; background:rgba(0,0,0,0.03);">` : ''}
      <div class="view-field">
        <div class="vlabel">プラットフォーム</div>
        <div class="vvalue">${escapeHtml(g.platform) || '未記入'}</div>
      </div>
      <div class="view-field">
        <div class="vlabel">ステータス</div>
        <div class="vvalue">${st.label}</div>
      </div>
      <div class="view-field">
        <div class="vlabel">評価</div>
        ${renderMeter(Number(g.rating)||0)}
      </div>
      <div class="row2">
        <div class="view-field">
          <div class="vlabel">プレイ時間</div>
          <div class="vvalue">${g.hours ? g.hours+' h' : '未記入'}</div>
        </div>
        <div class="view-field">
          <div class="vlabel">プレイしていた年</div>
          <div class="vvalue">${g.year ? g.year+'年' : '未記入'}</div>
        </div>
      </div>
      ${g.comment ? `
      <div class="view-field">
        <div class="vlabel">感想・メモ</div>
        <div class="view-comment">${escapeHtml(g.comment)}</div>
      </div>` : ''}
      <div class="modal-actions">
        <span></span>
        <button class="btn btn-secondary" id="closeViewBtn">閉じる</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#closeViewBtn').addEventListener('click', ()=>overlay.remove());
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) overlay.remove(); });
}

/* ---------------- 編集モーダル（自分の記録） ---------------- */
function openModal(id){
  const g = id ? games.find(x=>x.id===id) : null;
  const formState = g ? {...g} : {id:null, title:'', platform:'', status:'playing', rating:0, hours:'', year:'', comment:''};

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>${g ? 'ゲームを編集' : 'ゲームを追加'}</h2>
      <div class="field">
        <label>タイトル</label>
        <input type="text" id="f_title" value="${escapeHtml(formState.title)}" placeholder="例）ゼルダの伝説">
      </div>
      <div class="field">
        <label>パッケージ画像</label>
        <div class="cover-upload">
          <img id="f_cover_preview" class="cover-preview ${formState.coverUrl ? '' : 'hidden'}" src="${formState.coverUrl ? escapeHtml(formState.coverUrl) : ''}">
          <div class="cover-upload-col">
            <input type="file" id="f_cover" accept="image/*">
            <button type="button" class="cover-clear-btn ${formState.coverUrl ? '' : 'hidden'}" id="f_cover_clear">画像を削除</button>
          </div>
        </div>
      </div>
      <div class="row2">
        <div class="field">
          <label>プラットフォーム</label>
          <input type="text" id="f_platform" list="platformOptions" value="${escapeHtml(formState.platform)}" placeholder="Switch など">
        </div>
        <div class="field">
          <label>プレイ時間（h）</label>
          <input type="number" id="f_hours" min="0" step="0.5" value="${formState.hours || ''}">
        </div>
      </div>
      <div class="field">
        <label>ステータス</label>
        <div class="status-picker" id="f_status">
          ${STATUSES.map(s=>`<button type="button" data-key="${s.key}" class="${formState.status===s.key?'on':''}">${s.label}</button>`).join('')}
        </div>
        <div class="field-hint hidden" id="backlogHint">積みゲーの間は評価・プレイ時間を入力できません</div>
      </div>
      <div class="field">
        <label>評価（5段階）</label>
        <div class="rating-picker" id="f_rating">
          ${[1,2,3,4,5].map(n=>`<div class="blk ${n<=formState.rating?'on':''}" data-val="${n}"></div>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>プレイしていた年</label>
        <input type="number" id="f_year" min="1970" max="2100" step="1" placeholder="例）2008" value="${formState.year || ''}">
      </div>
      <div class="field">
        <label>感想・メモ</label>
        <textarea id="f_comment" placeholder="よかった点、思い出など自由に">${escapeHtml(formState.comment)}</textarea>
      </div>
      <div class="modal-actions">
        <div>${g ? `<button class="btn btn-danger" id="deleteBtn">削除</button>` : ''}</div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-secondary" id="cancelBtn">キャンセル</button>
          <button class="btn btn-primary" id="saveBtn">保存</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let currentRating = formState.rating || 0;
  let currentStatus = formState.status || 'playing';
  let coverCleared = false;

  function applyBacklogLock(){
    const isBacklog = currentStatus === 'backlog';
    overlay.querySelector('#f_rating').classList.toggle('disabled', isBacklog);
    overlay.querySelector('#f_hours').disabled = isBacklog;
    overlay.querySelector('#backlogHint').classList.toggle('hidden', !isBacklog);
    if(isBacklog){
      currentRating = 0;
      overlay.querySelectorAll('#f_rating .blk').forEach(b=>b.classList.remove('on'));
      overlay.querySelector('#f_hours').value = '';
    }
  }
  applyBacklogLock();

  overlay.querySelector('#f_cover').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    const preview = overlay.querySelector('#f_cover_preview');
    if(!file) return;
    if(file.size > 5*1024*1024){
      showToast('画像は5MB以下にしてください');
      e.target.value = '';
      return;
    }
    coverCleared = false;
    preview.src = URL.createObjectURL(file);
    preview.classList.remove('hidden');
    overlay.querySelector('#f_cover_clear').classList.remove('hidden');
  });
  overlay.querySelector('#f_cover_clear').addEventListener('click', ()=>{
    coverCleared = true;
    overlay.querySelector('#f_cover').value = '';
    overlay.querySelector('#f_cover_preview').classList.add('hidden');
    overlay.querySelector('#f_cover_clear').classList.add('hidden');
  });

  overlay.querySelector('#f_rating').addEventListener('click', (e)=>{
    const blk = e.target.closest('.blk');
    if(!blk) return;
    currentRating = Number(blk.dataset.val);
    overlay.querySelectorAll('#f_rating .blk').forEach(b=>{
      b.classList.toggle('on', Number(b.dataset.val) <= currentRating);
    });
  });
  overlay.querySelector('#f_status').addEventListener('click', (e)=>{
    const btn = e.target.closest('button');
    if(!btn) return;
    currentStatus = btn.dataset.key;
    overlay.querySelectorAll('#f_status button').forEach(b=>{
      b.classList.toggle('on', b.dataset.key===currentStatus);
    });
    applyBacklogLock();
  });
  overlay.querySelector('#cancelBtn').addEventListener('click', ()=>overlay.remove());
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) overlay.remove(); });

  const deleteBtn = overlay.querySelector('#deleteBtn');
  if(deleteBtn){
    deleteBtn.addEventListener('click', async ()=>{
      deleteBtn.disabled = true;
      const {error} = await sb.from('games').delete().eq('id', formState.id);
      if(error){ showToast('削除に失敗しました'); deleteBtn.disabled=false; return; }
      overlay.remove();
      await loadGames();
      showToast('削除しました');
    });
  }

  overlay.querySelector('#saveBtn').addEventListener('click', async ()=>{
    const title = overlay.querySelector('#f_title').value.trim();
    if(!title){ showToast('タイトルを入力してください'); return; }

    const saveBtn = overlay.querySelector('#saveBtn');
    saveBtn.disabled = true;

    let coverUrl = formState.coverUrl || null;
    const coverFile = overlay.querySelector('#f_cover').files[0];
    if(coverFile){
      const ext = (coverFile.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `${currentUser.id}/${crypto.randomUUID()}.${ext}`;
      const {error: uploadError} = await sb.storage.from('covers').upload(path, coverFile, {cacheControl:'3600', upsert:false});
      if(uploadError){
        showToast('画像のアップロードに失敗しました: ' + uploadError.message);
        saveBtn.disabled = false;
        return;
      }
      const {data: urlData} = sb.storage.from('covers').getPublicUrl(path);
      coverUrl = urlData.publicUrl;
    }else if(coverCleared){
      coverUrl = null;
    }

    const payload = {
      title,
      platform: overlay.querySelector('#f_platform').value.trim(),
      status: currentStatus,
      rating: currentRating,
      hours: overlay.querySelector('#f_hours').value ? Number(overlay.querySelector('#f_hours').value) : null,
      play_year: overlay.querySelector('#f_year').value ? Number(overlay.querySelector('#f_year').value) : null,
      comment: overlay.querySelector('#f_comment').value.trim(),
      cover_url: coverUrl,
      updated_at: new Date().toISOString()
    };

    let error;
    if(formState.id){
      ({error} = await sb.from('games').update(payload).eq('id', formState.id));
    }else{
      ({error} = await sb.from('games').insert({...payload, user_id: currentUser.id}));
    }
    saveBtn.disabled = false;
    if(error){ showToast('保存に失敗しました: ' + error.message); return; }
    overlay.remove();
    await loadGames();
    showToast(g ? '更新しました' : '追加しました');
  });
}
window.openModal = openModal;

/* ---------------- アイコン設定 ---------------- */
$('avatarBtn').addEventListener('click', ()=>{
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:380px; text-align:center;">
      <h2>プロフィール設定</h2>
      <img id="avatarPreview" class="avatar-upload-preview ${currentUser.avatarUrl ? '' : 'hidden'}" src="${currentUser.avatarUrl ? escapeHtml(currentUser.avatarUrl) : ''}">
      ${!currentUser.avatarUrl ? `<div class="avatar-upload-preview" style="display:flex;align-items:center;justify-content:center;font-size:32px;color:var(--ink-soft);" id="avatarPlaceholder">${escapeHtml(currentUser.username.charAt(0).toUpperCase())}</div>` : ''}
      <div class="field" style="text-align:left;">
        <label>アイコン画像</label>
        <input type="file" id="f_avatar" accept="image/*">
      </div>
      <div class="field" style="text-align:left;">
        <label>自己紹介</label>
        <textarea id="f_bio" placeholder="好きなジャンル、最近ハマってるゲームなど自由に" maxlength="200">${escapeHtml(currentUser.bio || '')}</textarea>
      </div>
      <div class="modal-actions">
        <span></span>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-secondary" id="avatarCancelBtn">閉じる</button>
          <button class="btn btn-primary" id="avatarSaveBtn">保存</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#f_avatar').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    if(file.size > 5*1024*1024){ showToast('画像は5MB以下にしてください'); e.target.value=''; return; }
    const preview = overlay.querySelector('#avatarPreview');
    preview.src = URL.createObjectURL(file);
    preview.classList.remove('hidden');
    const placeholder = overlay.querySelector('#avatarPlaceholder');
    if(placeholder) placeholder.classList.add('hidden');
  });
  overlay.querySelector('#avatarCancelBtn').addEventListener('click', ()=>overlay.remove());
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) overlay.remove(); });

  overlay.querySelector('#avatarSaveBtn').addEventListener('click', async ()=>{
    const saveBtn = overlay.querySelector('#avatarSaveBtn');
    saveBtn.disabled = true;

    const file = overlay.querySelector('#f_avatar').files[0];
    const bio = overlay.querySelector('#f_bio').value.trim();
    let avatarUrl = currentUser.avatarUrl || null;

    if(file){
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `${currentUser.id}/avatar-${crypto.randomUUID()}.${ext}`;
      const {error: uploadError} = await sb.storage.from('covers').upload(path, file, {cacheControl:'3600', upsert:false});
      if(uploadError){ showToast('アップロードに失敗しました: ' + uploadError.message); saveBtn.disabled=false; return; }
      const {data: urlData} = sb.storage.from('covers').getPublicUrl(path);
      avatarUrl = urlData.publicUrl;
    }

    const {error: updateError} = await sb.from('profiles').update({avatar_url: avatarUrl, bio}).eq('id', currentUser.id);
    saveBtn.disabled = false;
    if(updateError){ showToast('保存に失敗しました: ' + updateError.message); return; }

    currentUser.avatarUrl = avatarUrl;
    currentUser.bio = bio;
    updateAvatarUI();
    if(viewableProfiles.has(currentUser.id)){
      const p = viewableProfiles.get(currentUser.id);
      p.avatar_url = avatarUrl;
      p.bio = bio;
    }
    if(viewingUserId === currentUser.id) renderViewingProfile(currentUser.id);
    overlay.remove();
    showToast('プロフィールを更新しました');
  });
});

/* ---------------- グループ管理 ---------------- */
async function fetchMyGroups(){
  const {data: myMemberships, error} = await sb
    .from('group_members')
    .select('group_id, groups(id, name, owner_id)')
    .eq('user_id', currentUser.id);
  if(error || !myMemberships) return [];

  const groupsMap = new Map();
  myMemberships.forEach(m=>{ if(m.groups) groupsMap.set(m.groups.id, m.groups); });
  const groupIds = Array.from(groupsMap.keys());
  if(groupIds.length === 0) return [];

  const {data: allMemberRows} = await sb.from('group_members').select('group_id, user_id').in('group_id', groupIds);
  const userIds = Array.from(new Set((allMemberRows||[]).map(r=>r.user_id)));
  const {data: profs} = await sb.from('profiles').select('id, username').in('id', userIds);
  const profMap = new Map((profs||[]).map(p=>[p.id,p]));

  return groupIds.map(gid=>{
    const g = groupsMap.get(gid);
    const members = (allMemberRows||[])
      .filter(r=>r.group_id===gid)
      .map(r=>profMap.get(r.user_id))
      .filter(Boolean)
      .sort((a,b)=>a.username.localeCompare(b.username,'ja'));
    return {...g, members};
  });
}

async function renderGroupModalBody(overlay){
  const body = overlay.querySelector('#groupModalBody');
  body.innerHTML = '<div class="loading" style="padding:20px;">読み込み中...</div>';
  const groups = await fetchMyGroups();

  if(groups.length === 0){
    body.innerHTML = `<p class="group-empty">まだどのグループにも所属していません。下記から作成してください。</p>`;
  }else{
    body.innerHTML = groups.map(g=>{
      const isOwner = g.owner_id === currentUser.id;
      return `
        <div class="group-block">
          <div class="group-head">
            <span>${escapeHtml(g.name)}</span>
            ${isOwner ? `<span class="owner-badge">オーナー</span>` : ''}
          </div>
          <div class="group-members">
            ${g.members.map(m=>`
              <span class="member-chip">
                ${escapeHtml(m.username)}
                ${isOwner && m.id !== currentUser.id ? `<button class="remove-member-btn" data-group="${g.id}" data-user="${m.id}" title="削除">×</button>` : ''}
              </span>`).join('')}
          </div>
          <div class="invite-row">
            <input type="text" class="invite-input" data-group="${g.id}" placeholder="招待するユーザーID">
            <button class="invite-btn" data-group="${g.id}">招待</button>
          </div>
          ${!isOwner ? `<button class="leave-group-btn" data-group="${g.id}">このグループを抜ける</button>` : ''}
        </div>`;
    }).join('');
  }

  body.querySelectorAll('.invite-btn').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const gid = btn.dataset.group;
      const input = body.querySelector(`.invite-input[data-group="${gid}"]`);
      const uname = input.value.trim();
      if(!uname) return;
      btn.disabled = true;
      const {data: prof, error: findError} = await sb.from('profiles').select('id, username').ilike('username', uname).maybeSingle();
      if(findError || !prof){
        showToast('そのIDのユーザーが見つかりません');
        btn.disabled = false;
        return;
      }
      const {error: insertError} = await sb.from('group_members').insert({group_id: gid, user_id: prof.id});
      btn.disabled = false;
      if(insertError){
        showToast(insertError.code === '23505' ? 'すでにメンバーです' : '招待に失敗しました: ' + insertError.message);
        return;
      }
      showToast(`${prof.username}さんを招待しました`);
      input.value = '';
      await renderGroupModalBody(overlay);
      await loadViewableUsers();
    });
  });

  body.querySelectorAll('.remove-member-btn').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      if(!confirm('このメンバーをグループから削除しますか？')) return;
      const {error} = await sb.from('group_members').delete().eq('group_id', btn.dataset.group).eq('user_id', btn.dataset.user);
      if(error){ showToast('削除に失敗しました'); return; }
      showToast('削除しました');
      await renderGroupModalBody(overlay);
      await loadViewableUsers();
    });
  });

  body.querySelectorAll('.leave-group-btn').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      if(!confirm('このグループを抜けますか？')) return;
      const {error} = await sb.from('group_members').delete().eq('group_id', btn.dataset.group).eq('user_id', currentUser.id);
      if(error){ showToast('操作に失敗しました'); return; }
      showToast('グループを抜けました');
      await renderGroupModalBody(overlay);
      await loadViewableUsers();
      if(viewingUserId !== currentUser.id) setViewingUser(currentUser.id);
    });
  });
}

$('groupBtn').addEventListener('click', async ()=>{
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>グループ管理</h2>
      <p style="font-size:12.5px; color:var(--ink-soft); margin-top:-10px;">同じグループのメンバー同士だけがお互いのゲームログを見られます。</p>
      <div id="groupModalBody"></div>
      <div class="field" style="margin-top:6px;">
        <label>新しいグループを作成</label>
        <div style="display:flex; gap:8px;">
          <input type="text" id="newGroupName" placeholder="グループ名（例: 高校の友達）">
          <button class="btn btn-primary" id="createGroupBtn" style="flex-shrink:0;">作成</button>
        </div>
      </div>
      <div class="modal-actions">
        <span></span>
        <button class="btn btn-secondary" id="groupCloseBtn">閉じる</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#groupCloseBtn').addEventListener('click', ()=>overlay.remove());
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) overlay.remove(); });

  overlay.querySelector('#createGroupBtn').addEventListener('click', async ()=>{
    const name = overlay.querySelector('#newGroupName').value.trim();
    if(!name){ showToast('グループ名を入力してください'); return; }
    const btn = overlay.querySelector('#createGroupBtn');
    btn.disabled = true;
    const {data: newGroup, error} = await sb.from('groups').insert({name, owner_id: currentUser.id}).select().single();
    if(error){ showToast('作成に失敗しました: ' + error.message); btn.disabled=false; return; }
    const {error: memberError} = await sb.from('group_members').insert({group_id: newGroup.id, user_id: currentUser.id});
    btn.disabled = false;
    if(memberError){ showToast('作成に失敗しました: ' + memberError.message); return; }
    overlay.querySelector('#newGroupName').value = '';
    showToast('グループを作成しました');
    await renderGroupModalBody(overlay);
    await loadViewableUsers();
  });

  await renderGroupModalBody(overlay);
});

/* ---------------- 検索・並び替え ---------------- */
$('searchInput').addEventListener('input', (e)=>{ searchQuery = e.target.value; renderGrid(); });
$('sortSelect').addEventListener('change', (e)=>{ sortMode = e.target.value; renderGrid(); });
$('addBtn').addEventListener('click', ()=>openModal());

/* ---------------- 書き出し / 読み込み ---------------- */
$('exportBtn').addEventListener('click', ()=>{
  const blob = new Blob([JSON.stringify(games, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const today = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `game-log-${today}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('書き出しました');
});

$('importBtn').addEventListener('click', ()=> $('importFile').click());
$('importFile').addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const text = await file.text();
    const imported = JSON.parse(text);
    if(!Array.isArray(imported)) throw new Error('不正な形式です');
    const ok = confirm(`${imported.length}件のデータを、自分の記録として追加します。よろしいですか？`);
    if(ok){
      const rows = imported.map(g=>({
        user_id: currentUser.id,
        title: g.title || '無題',
        platform: g.platform || '',
        status: g.status || 'playing',
        rating: g.rating || 0,
        hours: g.hours ? Number(g.hours) : null,
        play_year: g.year ? Number(g.year) : null,
        comment: g.comment || '',
        cover_url: g.coverUrl || null,
        updated_at: new Date().toISOString()
      }));
      const {error} = await sb.from('games').insert(rows);
      if(error) throw error;
      await loadGames();
      showToast('読み込みました');
    }
  }catch(err){
    showToast('ファイルの読み込みに失敗しました');
  }
  e.target.value = '';
});

/* ---------------- 起動処理 ---------------- */
(async function boot(){
  initSupabase();
  initTheme();
  setAuthMode('login');

  const {data:{session}} = await sb.auth.getSession();
  if(session){
    await onLoggedIn(session.user);
  }
})();

})();
