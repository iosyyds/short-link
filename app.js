'use strict';
/* ================= 常量与状态 ================= */
var STORE_KEY = 'short_link_history_v1';
var MAX_HISTORY = 50;
var VGD_ERRORS = {
  1: '请输入需要缩短的网址',
  2: '网址格式不正确，请检查后重试',
  3: '该网址被短链服务拒绝',
  4: '短链服务暂时达到使用上限，请稍后再试',
  5: '无法访问该网址，请确认链接可以正常打开',
  6: '自定义别名无效，仅支持 4–30 位字母或数字',
  7: '该别名已被占用，换一个试试',
  8: '该别名是保留词，无法使用'
};
var history = loadHistory();
var currentShort = '';

function $(id){ return document.getElementById(id); }

/* ================= 工具函数 ================= */
function normalizeUrl(raw){
  var s = raw.trim();
  if(!s) return '';
  if(!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)){ s = 'https://' + s; }
  return s;
}
function isValidHttpUrl(s){
  try{
    var u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.host;
  }catch(e){ return false; }
}
function showError(msg){
  $('errorMsg').textContent = msg;
  $('errorText').classList.add('show');
}
function clearError(){
  $('errorText').classList.remove('show');
}
function setLoading(loading){
  var btn = $('submitBtn');
  btn.disabled = loading;
  if(loading){
    $('submitText').textContent = '生成中…';
    var sp = document.createElement('span');
    sp.className = 'spinner';
    sp.id = 'btnSpinner';
    btn.insertBefore(sp, $('submitText'));
  }else{
    $('submitText').textContent = '立即缩短';
    var old = $('btnSpinner');
    if(old) old.remove();
  }
}
function fetchText(url, timeoutMs){
  var controller = new AbortController();
  var timer = setTimeout(function(){ controller.abort(); }, timeoutMs);
  return fetch(url, {signal: controller.signal, cache: 'no-store'})
    .then(function(res){
      if(!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    })
    .finally(function(){ clearTimeout(timer); });
}
function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

/* ================= 短链 API ================= */
function shortenVgd(url, alias){
  var api = 'https://v.gd/create.php?format=json&url=' + encodeURIComponent(url) + '&logstats=1';
  if(alias) api += '&shorturl=' + encodeURIComponent(alias);
  return fetchText(api, 12000).then(function(text){
    var data;
    try{ data = JSON.parse(text); }
    catch(e){ throw new Error('BAD_RESPONSE'); }
    if(data.shorturl) return {short: data.shorturl, via: 'v.gd'};
    var code = data.errorcode;
    var msg = VGD_ERRORS[code] || data.errormessage || '短链服务返回错误';
    var err = new Error(msg);
    err.vgdCode = code;
    throw err;
  });
}
function shortenDagd(url){
  var api = 'https://da.gd/shorten?url=' + encodeURIComponent(url);
  return fetchText(api, 12000).then(function(text){
    var s = text.trim();
    if(/^https?:\/\//.test(s)) return {short: s, via: 'da.gd'};
    throw new Error(s || '备用服务返回错误');
  });
}
function shorten(url, alias){
  var attempts = 0;
  function tryVgd(){
    attempts++;
    return shortenVgd(url, alias).catch(function(err){
      // v.gd 明确的业务错误（如别名占用/格式错）不重试，直接上抛
      if(err.vgdCode) throw err;
      if(attempts < 3) return sleep(700).then(tryVgd);
      throw err;
    });
  }
  return tryVgd().catch(function(err){
    if(err.vgdCode) throw err; // 业务错误不降级
    return shortenDagd(url).then(function(r){
      if(alias) r.fallbackNote = '别名服务暂不可用，已生成随机短链';
      return r;
    });
  });
}

/* ================= 结果展示 ================= */
function renderResult(short, original, note){
  currentShort = short;
  var link = $('resultLink');
  link.href = short;
  link.textContent = short;
  $('originalText').textContent = original;
  resetCopyBtn();
  $('resultCard').classList.add('show');
  if(note) toast(note);
  setTimeout(function(){
    $('resultCard').scrollIntoView({behavior: 'smooth', block: 'nearest'});
  }, 60);
}
function resetCopyBtn(){
  var btn = $('copyBtn');
  btn.classList.remove('copied');
  btn.querySelector('span').textContent = '复制链接';
}

/* ================= 复制 ================= */
function copyText(text){
  if(navigator.clipboard && window.isSecureContext){
    return navigator.clipboard.writeText(text);
  }
  return new Promise(function(resolve, reject){
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try{
      document.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
    }catch(e){ reject(e); }
    document.body.removeChild(ta);
  });
}

/* ================= 二维码（qrcodejs 本地渲染） ================= */
function showQr(text){
  if(!window.QRCode){
    toast('二维码组件加载失败，请检查网络');
    return;
  }
  var holder = document.createElement('div');
  holder.style.position = 'fixed';
  holder.style.left = '-9999px';
  holder.style.top = '0';
  try{
    document.body.appendChild(holder);
    new window.QRCode(holder, {
      text: text,
      width: 440,
      height: 440,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: window.QRCode.CorrectLevel.M
    });
    var canvas = holder.querySelector('canvas');
    var url = canvas ? canvas.toDataURL('image/png') : '';
    document.body.removeChild(holder);
    if(!url){ toast('二维码生成失败'); return; }
    $('qrImg').src = url;
    $('qrLink').textContent = text;
    openModal($('qrModal'));
  }catch(e){
    if(holder.parentNode) document.body.removeChild(holder);
    toast('二维码生成失败');
  }
}

/* ================= 历史记录 ================= */
function loadHistory(){
  try{
    var raw = localStorage.getItem(STORE_KEY);
    var arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  }catch(e){ return []; }
}
function saveHistory(){
  try{ localStorage.setItem(STORE_KEY, JSON.stringify(history)); }catch(e){}
}
function addHistory(item){
  history.unshift(item);
  if(history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  saveHistory();
  renderHistory();
}
function removeHistory(id){
  history = history.filter(function(it){ return it.id !== id; });
  saveHistory();
  renderHistory();
}
function formatTime(ts){
  var d = new Date(ts);
  function pad(n){ return n < 10 ? '0' + n : '' + n; }
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function iconSvg(name){
  var paths = {
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'
  };
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths[name] + '</svg>';
}
function renderHistory(){
  var list = $('historyList');
  list.textContent = '';
  $('emptyTip').style.display = history.length ? 'none' : 'block';
  $('clearBtn').hidden = history.length === 0;

  history.forEach(function(it){
    var li = document.createElement('li');
    li.className = 'glass history-item';

    var main = document.createElement('div');
    main.className = 'hi-main';

    var shortWrap = document.createElement('div');
    shortWrap.className = 'hi-short';
    var a = document.createElement('a');
    a.href = it.short;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = it.short;
    shortWrap.appendChild(a);
    if(it.alias){
      var badge = document.createElement('span');
      badge.className = 'hi-badge';
      badge.textContent = '自定义';
      shortWrap.appendChild(badge);
    }

    var orig = document.createElement('div');
    orig.className = 'hi-orig';
    orig.textContent = it.original;
    orig.title = it.original;

    var time = document.createElement('div');
    time.className = 'hi-time';
    time.textContent = formatTime(it.createdAt);

    main.appendChild(shortWrap);
    main.appendChild(orig);
    main.appendChild(time);

    var actions = document.createElement('div');
    actions.className = 'hi-actions';

    var copyBtn = document.createElement('button');
    copyBtn.className = 'round-btn';
    copyBtn.type = 'button';
    copyBtn.title = '复制';
    copyBtn.innerHTML = iconSvg('copy');
    copyBtn.addEventListener('click', function(){
      copyText(it.short).then(function(){ toast('已复制到剪贴板'); }).catch(function(){ toast('复制失败'); });
    });

    var delBtn = document.createElement('button');
    delBtn.className = 'round-btn del';
    delBtn.type = 'button';
    delBtn.title = '删除';
    delBtn.innerHTML = iconSvg('trash');
    delBtn.addEventListener('click', function(){ removeHistory(it.id); });

    actions.appendChild(copyBtn);
    actions.appendChild(delBtn);

    li.appendChild(main);
    li.appendChild(actions);
    list.appendChild(li);
  });
}

/* ================= Toast ================= */
function toast(msg){
  var box = $('toastContainer');
  var el = document.createElement('div');
  el.className = 'toast';
  var check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  check.setAttribute('viewBox', '0 0 24 24');
  check.setAttribute('fill', 'none');
  check.setAttribute('stroke', 'currentColor');
  check.setAttribute('stroke-width', '2.4');
  check.setAttribute('stroke-linecap', 'round');
  check.setAttribute('stroke-linejoin', 'round');
  check.innerHTML = '<polyline points="20 6 9 17 4 12"/>';
  var txt = document.createElement('span');
  txt.textContent = msg;
  el.appendChild(check);
  el.appendChild(txt);
  box.appendChild(el);
  setTimeout(function(){
    el.classList.add('out');
    setTimeout(function(){ el.remove(); }, 280);
  }, 2200);
}

/* ================= 弹窗 ================= */
var confirmHandler = null;
function openModal(modal){ modal.classList.add('show'); }
function closeModal(modal){ modal.classList.remove('show'); }
function openConfirm(title, msg, onOk){
  $('confirmTitle').textContent = title;
  $('confirmMsg').textContent = msg;
  confirmHandler = onOk;
  openModal($('confirmModal'));
}

/* ================= 事件绑定 ================= */
$('shortForm').addEventListener('submit', function(e){
  e.preventDefault();
  clearError();
  var url = normalizeUrl($('urlInput').value);
  var alias = $('aliasInput').value.trim();

  if(!url){ showError('请输入需要缩短的网址'); return; }
  if(!isValidHttpUrl(url)){ showError('网址格式不正确，请检查后重试'); return; }
  if(alias){
    if(alias.length < 4 || alias.length > 30){ showError('自定义别名需为 4–30 位字母或数字'); return; }
    if(!/^[a-zA-Z0-9]+$/.test(alias)){ showError('自定义别名只能包含字母或数字'); return; }
  }

  setLoading(true);
  shorten(url, alias)
    .then(function(r){
      var item = {
        id: Date.now() + '' + Math.floor(Math.random() * 1000),
        short: r.short,
        original: url,
        alias: alias,
        via: r.via,
        createdAt: Date.now()
      };
      addHistory(item);
      renderResult(r.short, url, r.fallbackNote || '');
    })
    .catch(function(err){
      showError(err.message || '生成失败，请稍后再试');
    })
    .then(function(){ setLoading(false); });
});

// 别名输入实时过滤非法字符
$('aliasInput').addEventListener('input', function(e){
  var cleaned = e.target.value.replace(/[^a-zA-Z0-9]/g, '');
  if(cleaned !== e.target.value) e.target.value = cleaned;
});

$('copyBtn').addEventListener('click', function(){
  if(!currentShort) return;
  copyText(currentShort).then(function(){
    var btn = $('copyBtn');
    btn.classList.add('copied');
    btn.querySelector('span').textContent = '已复制';
    toast('已复制到剪贴板');
    setTimeout(resetCopyBtn, 1800);
  }).catch(function(){ toast('复制失败'); });
});

$('qrBtn').addEventListener('click', function(){
  if(currentShort) showQr(currentShort);
});

$('clearBtn').addEventListener('click', function(){
  openConfirm('清空历史记录', '将删除本机保存的全部 ' + history.length + ' 条短链记录，此操作不可恢复。', function(){
    history = [];
    saveHistory();
    renderHistory();
    toast('历史记录已清空');
  });
});

$('confirmOk').addEventListener('click', function(){
  closeModal($('confirmModal'));
  if(typeof confirmHandler === 'function') confirmHandler();
  confirmHandler = null;
});

// 弹窗统一关闭：data-close / 点击遮罩 / Esc
document.querySelectorAll('.modal-mask').forEach(function(mask){
  mask.addEventListener('click', function(e){
    if(e.target === mask || e.target.hasAttribute('data-close')){
      closeModal(mask);
      confirmHandler = null;
    }
  });
});
document.addEventListener('keydown', function(e){
  if(e.key === 'Escape'){
    document.querySelectorAll('.modal-mask.show').forEach(function(m){
      closeModal(m);
      confirmHandler = null;
    });
  }
});

/* ================= 初始化 ================= */
renderHistory();
