'use strict';

const $ = (id) => document.getElementById(id);

// --- Yardımcılar ---------------------------------------------------------

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtPara(n) {
  return Number(n).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Bir hücre değeri: null/boş ise "-", değilse escape edilmiş metin
function hucre(v) {
  return v == null || v === '' ? '-' : esc(String(v));
}

async function api(url, opts = {}) {
  const fetchOpts = { method: opts.method || 'GET' };
  if (opts.body !== undefined) {
    fetchOpts.headers = { 'Content-Type': 'application/json' };
    fetchOpts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, fetchOpts);
  let json = {};
  try { json = await res.json(); } catch { /* gövdesiz yanıt */ }
  if (!res.ok) {
    const detay = json.detaylar ? ` (${json.detaylar.join(', ')})` : '';
    throw new Error((json.error || `Sunucu hatası: ${res.status}`) + detay);
  }
  return json;
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = isError ? 'toast-error' : 'toast-ok';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'hidden'; }, isError ? 5000 : 2500);
}

// Bir kapsayıcıdaki data-f="alan" girdilerini {alan: değer} nesnesine toplar.
// Boş string → null (alanı temizle anlamına gelir).
function alanlariTopla(container) {
  const out = {};
  container.querySelectorAll('[data-f]').forEach((inp) => {
    const v = inp.value.trim();
    out[inp.dataset.f] = v === '' ? null : v;
  });
  return out;
}

// --- Düzenleme modu ------------------------------------------------------

let editMode = localStorage.getItem('editMode') === '1';
const editToggle = $('edit-mode-toggle');
editToggle.checked = editMode;
document.body.classList.toggle('edit-mode', editMode);

editToggle.addEventListener('change', () => {
  editMode = editToggle.checked;
  localStorage.setItem('editMode', editMode ? '1' : '0');
  document.body.classList.toggle('edit-mode', editMode);
  if (currentDoc) openDetail(currentDoc.id);         // modalı yeni modda tazele
  if (aktifTab === 'taraflar') loadTaraflar();
});

// --- Kar Oranı Yönetimi ----------------------------------------------------
let profitMargin = parseFloat(localStorage.getItem('profitMargin')) || 0;
const marginInput = $('profit-margin-input');
if (marginInput) {
  marginInput.value = profitMargin;
  marginInput.addEventListener('input', () => {
    let val = parseFloat(marginInput.value);
    if (isNaN(val) || val < 0) val = 0;
    profitMargin = val;
    localStorage.setItem('profitMargin', profitMargin);
    if (currentDoc) openDetail(currentDoc.id); // modalı yeni kar oranıyla tazele
    if (aktifTab === 'kalem-arama') loadKalemArama(kalemPage); // kalem aramayı tazele
  });
}

// --- Tab yönetimi --------------------------------------------------------

let aktifTab = 'belgeler';
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    aktifTab = btn.dataset.tab;
    $('tab-' + aktifTab).classList.add('active');
    if (aktifTab === 'gozden-gecir') loadGozdenGecir();
    if (aktifTab === 'taraflar') loadTaraflar();
  });
});

// --- Belgeler sekmesi ----------------------------------------------------

let currentPage = 0;
const PAGE_SIZE = 50;

function buildFilters() {
  const f = {
    tarih_baslangic: $('f-tarih-bas').value,
    tarih_bitis: $('f-tarih-bit').value,
    belge_tipi: $('f-tip').value,
    parse_durumu: $('f-durum').value,
    satici: $('f-satici').value.trim(),
    alici: $('f-alici').value.trim(),
    belge_no: $('f-belge-no').value.trim(),
  };
  Object.keys(f).forEach((k) => { if (!f[k]) delete f[k]; });
  return f;
}

async function loadBelgeler(page = 0) {
  currentPage = page;
  const el = $('belgeler-sonuc');
  el.innerHTML = '<p class="info">Yükleniyor…</p>';
  const params = new URLSearchParams({ ...buildFilters(), limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  try {
    const json = await api('/api/documents?' + params);
    renderBelgeler(json, page);
  } catch (err) {
    el.innerHTML = `<p class="error">Yüklenemedi: ${esc(err.message)}</p>`;
  }
}

function renderBelgeler({ total, data }, page) {
  const el = $('belgeler-sonuc');
  if (!data.length) {
    el.innerHTML = '<p class="empty">Sonuç bulunamadı.</p>';
    $('pagination').innerHTML = '';
    return;
  }

  el.innerHTML = `
    <p class="info">${total.toLocaleString('tr-TR')} belge bulundu.</p>
    <table>
      <thead>
        <tr>
          <th>#</th><th>Tarih</th><th>Tip</th><th>Belge No</th>
          <th>Satıcı</th><th>Alıcı</th>
          <th class="num">Toplam (TL)</th><th>Durum</th>
        </tr>
      </thead>
      <tbody>
        ${data.map((d) => `
          <tr data-id="${d.id}">
            <td>${d.id}</td>
            <td>${hucre(d.duzenleme_tarihi)}</td>
            <td>${hucre(d.belge_tipi)}</td>
            <td>${hucre(d.belge_no)}</td>
            <td>${hucre(d.satici_unvan)}</td>
            <td>${hucre(d.alici_unvan)}</td>
            <td class="num">${d.odenecek_tutar != null ? fmtPara(d.odenecek_tutar) : '-'}</td>
            <td><span class="badge badge-${esc(d.parse_durumu)}">${esc(d.parse_durumu)}</span></td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  el.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', () => openDetail(parseInt(tr.dataset.id, 10)));
  });

  renderPagination($('pagination'), total, page, loadBelgeler);
}

// Pencereli sayfalama: 1 … (aktif±2) … son — binlerce sayfada buton patlaması olmaz
function renderPagination(el, total, page, onPage) {
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) { el.innerHTML = ''; return; }

  const nums = new Set([0, 1, pages - 2, pages - 1]);
  for (let i = page - 2; i <= page + 2; i++) if (i >= 0 && i < pages) nums.add(i);
  const sirali = [...nums].filter((i) => i >= 0 && i < pages).sort((a, b) => a - b);

  const parts = [`<button ${page === 0 ? 'disabled' : ''} data-p="${page - 1}">‹</button>`];
  let prev = -1;
  for (const i of sirali) {
    if (prev !== -1 && i - prev > 1) parts.push('<span class="page-gap">…</span>');
    parts.push(`<button class="${i === page ? 'active' : ''}" data-p="${i}">${i + 1}</button>`);
    prev = i;
  }
  parts.push(`<button ${page >= pages - 1 ? 'disabled' : ''} data-p="${page + 1}">›</button>`);
  el.innerHTML = parts.join('');
  el.querySelectorAll('button[data-p]').forEach((b) => {
    b.addEventListener('click', () => onPage(parseInt(b.dataset.p, 10)));
  });
}

$('btn-ara').addEventListener('click', () => loadBelgeler(0));
$('btn-temizle').addEventListener('click', () => {
  ['f-tarih-bas', 'f-tarih-bit', 'f-satici', 'f-alici', 'f-belge-no'].forEach((id) => { $(id).value = ''; });
  $('f-tip').value = '';
  $('f-durum').value = '';
  loadBelgeler(0);
});
document.querySelectorAll('#tab-belgeler input, #tab-belgeler select').forEach((el) => {
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadBelgeler(0); });
});

// --- Kalem arama ---------------------------------------------------------

let kalemPage = 0;

$('btn-kalem-ara').addEventListener('click', () => loadKalemArama(0));
$('kalem-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadKalemArama(0); });

async function loadKalemArama(page = 0) {
  kalemPage = page;
  const q = $('kalem-q').value.trim();
  const el = $('kalem-sonuc');
  if (q.length < 2) { el.innerHTML = '<p class="info">En az 2 karakter girin.</p>'; $('kalem-pagination').innerHTML = ''; return; }

  el.innerHTML = '<p class="info">Aranıyor…</p>';
  try {
    const json = await api('/api/items?' + new URLSearchParams({ q, limit: PAGE_SIZE, offset: page * PAGE_SIZE }));
    if (!json.data.length) { el.innerHTML = '<p class="empty">Sonuç bulunamadı.</p>'; $('kalem-pagination').innerHTML = ''; return; }

    const toplamTutar = json.data.reduce((s, i) => s + (i.mal_hizmet_tutari || 0), 0);
    el.innerHTML = `
      <p class="info">${json.total.toLocaleString('tr-TR')} kalem bulundu (bu sayfadaki tutar toplamı: ${fmtPara(toplamTutar)} TL).</p>
      <table>
        <thead>
          <tr><th>Belge No</th><th>Tarih</th><th>Satıcı</th><th>Açıklama</th><th class="num">Miktar</th><th class="num">Birim Fiyat</th><th class="num">KDV%</th><th class="num">Tutar</th><th class="num satis-fiyati" title="Kar oranına göre tarayıcıda hesaplanır; kayıtlı veri değildir">Satış Fiyatı</th></tr>
        </thead>
        <tbody>
          ${json.data.map((i) => {
            const satisFiyati = i.birim_fiyat != null ? i.birim_fiyat * (1 + profitMargin / 100) : null;
            return `
              <tr data-id="${i.document_id}">
                <td>${hucre(i.belge_no)}</td>
                <td>${hucre(i.duzenleme_tarihi)}</td>
                <td>${hucre(i.satici_unvan)}</td>
                <td>${hucre(i.aciklama)}</td>
                <td class="num">${i.miktar != null ? esc(String(i.miktar)) : '-'} ${hucre(i.birim) === '-' ? '' : hucre(i.birim)}</td>
                <td class="num">${i.birim_fiyat != null ? fmtPara(i.birim_fiyat) : '-'}</td>
                <td class="num">${i.kdv_orani != null ? '%' + esc(String(i.kdv_orani)) : '-'}</td>
                <td class="num">${i.mal_hizmet_tutari != null ? fmtPara(i.mal_hizmet_tutari) : '-'}</td>
                <td class="num satis-fiyati">${satisFiyati != null ? fmtPara(satisFiyati) : '-'}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>`;

    el.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => openDetail(parseInt(tr.dataset.id, 10)));
    });
    renderPagination($('kalem-pagination'), json.total, page, loadKalemArama);
  } catch (err) {
    el.innerHTML = `<p class="error">Yüklenemedi: ${esc(err.message)}</p>`;
  }
}

// --- Taraflar sekmesi ----------------------------------------------------

$('btn-taraf-ara').addEventListener('click', loadTaraflar);
$('taraf-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadTaraflar(); });

const tarafCache = new Map();

async function loadTaraflar() {
  const el = $('taraf-sonuc');
  el.innerHTML = '<p class="info">Yükleniyor…</p>';
  const q = $('taraf-q').value.trim();
  try {
    const json = await api('/api/taraflar?' + new URLSearchParams(q ? { q, limit: 200 } : { limit: 200 }));
    tarafCache.clear();
    json.data.forEach((t) => tarafCache.set(t.id, t));
    if (!json.data.length) { el.innerHTML = '<p class="empty">Kayıtlı taraf yok.</p>'; return; }

    el.innerHTML = `
      <p class="info">${json.total.toLocaleString('tr-TR')} taraf.</p>
      <table>
        <thead>
          <tr><th>Unvan</th><th>VKN/TCKN</th><th>Vergi Dairesi</th><th>E-Posta</th><th>Telefon</th><th class="num">Belge</th>${editMode ? '<th></th>' : ''}</tr>
        </thead>
        <tbody>
          ${json.data.map((t) => tarafSatiri(t)).join('')}
        </tbody>
      </table>`;
  } catch (err) {
    el.innerHTML = `<p class="error">Yüklenemedi: ${esc(err.message)}</p>`;
  }
}

function tarafSatiri(t) {
  return `
    <tr data-taraf-id="${t.id}" class="no-click">
      <td>${hucre(t.unvan)}</td>
      <td>${hucre(t.vkn_tckn)}</td>
      <td>${hucre(t.vergi_dairesi)}</td>
      <td>${hucre(t.eposta)}</td>
      <td>${hucre(t.telefon)}</td>
      <td class="num">${(t.satici_belge_sayisi || 0) + (t.alici_belge_sayisi || 0)}</td>
      ${editMode ? `<td class="row-actions"><button class="btn-kucuk" data-action="taraf-duzenle">Düzenle</button></td>` : ''}
    </tr>`;
}

function tarafDuzenleSatiri(t) {
  const inp = (f, v, ph, w) =>
    `<input type="text" data-f="${f}" value="${v == null ? '' : esc(String(v))}" placeholder="${ph}" style="width:${w}px" />`;
  return `
    <tr data-taraf-id="${t.id}" class="edit-row no-click">
      <td>${inp('unvan', t.unvan, 'Unvan (zorunlu)', 220)}</td>
      <td>${inp('vkn_tckn', t.vkn_tckn, 'VKN/TCKN', 110)}</td>
      <td>${inp('vergi_dairesi', t.vergi_dairesi, 'Vergi dairesi', 140)}</td>
      <td>${inp('eposta', t.eposta, 'E-posta', 150)}</td>
      <td>${inp('telefon', t.telefon, 'Telefon', 110)}</td>
      <td class="num">${(t.satici_belge_sayisi || 0) + (t.alici_belge_sayisi || 0)}</td>
      <td class="row-actions">
        <button class="btn-kucuk btn-yesil" data-action="taraf-kaydet">Kaydet</button>
        <button class="btn-kucuk btn-gri" data-action="taraf-iptal">İptal</button>
      </td>
    </tr>`;
}

// Taraf tablosu olay delegasyonu
$('taraf-sonuc').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const tr = btn.closest('tr[data-taraf-id]');
  const id = parseInt(tr.dataset.tarafId, 10);

  if (btn.dataset.action === 'taraf-duzenle') {
    const t = tarafCache.get(id);
    if (t) tr.outerHTML = tarafDuzenleSatiri(t);
  } else if (btn.dataset.action === 'taraf-iptal') {
    loadTaraflar();
  } else if (btn.dataset.action === 'taraf-kaydet') {
    const fields = alanlariTopla(tr);
    try {
      await api(`/api/taraflar/${id}`, { method: 'PATCH', body: fields });
      toast('Taraf güncellendi.');
      loadTaraflar();
    } catch (err) { toast(err.message, true); }
  }
});

// --- PDF Yükle sekmesi ----------------------------------------------------

const dropZone = $('drop-zone');
const fileInput = $('file-input');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag');
  yukleDosyalar([...e.dataTransfer.files]);
});
fileInput.addEventListener('change', () => {
  yukleDosyalar([...fileInput.files]);
  fileInput.value = '';
});

let yukleDevam = false;

async function yukleDosyalar(files) {
  const pdfler = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  const atlanan = files.length - pdfler.length;
  if (!pdfler.length) { toast('PDF dosyası seçilmedi.', true); return; }
  if (yukleDevam) { toast('Önceki yükleme hâlâ sürüyor, bekleyin.', true); return; }
  yukleDevam = true;

  const el = $('yukle-sonuc');
  el.innerHTML = `
    ${atlanan ? `<p class="info">${atlanan} PDF olmayan dosya atlandı.</p>` : ''}
    <table>
      <thead><tr><th>Dosya</th><th>Sonuç</th><th>Belge No</th><th class="num">Kalem</th><th>Not</th></tr></thead>
      <tbody id="yukle-tbody"></tbody>
    </table>`;
  const tbody = $('yukle-tbody');

  let basarili = 0;
  for (const f of pdfler) {
    const tr = document.createElement('tr');
    tr.className = 'no-click';
    tr.innerHTML = `<td>${esc(f.name)}</td><td colspan="4" class="info">Yükleniyor…</td>`;
    tbody.appendChild(tr);

    try {
      const res = await fetch('/api/upload?filename=' + encodeURIComponent(f.name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: f,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok && !json.durum) throw new Error(json.error || `Sunucu hatası: ${res.status}`);

      // Bir PDF'te birden fazla fatura olabilir — her belge ayrı satır olur.
      const belgeler = json.belgeler && json.belgeler.length ? json.belgeler : [json];
      let oncekiSatir = tr;
      belgeler.forEach((belge, idx) => {
        const satir = idx === 0 ? tr : document.createElement('tr');
        if (idx > 0) {
          satir.className = 'no-click';
          oncekiSatir.after(satir);
        }
        oncekiSatir = satir;
        const dosyaAd = belgeler.length > 1 ? `${f.name} (${idx + 1}/${belgeler.length})` : f.name;
        const badge = `<span class="badge badge-${esc(belge.durum)}">${esc(belge.durum)}</span>`;
        satir.innerHTML = `
          <td>${esc(dosyaAd)}</td>
          <td>${badge}</td>
          <td>${hucre(belge.belge_no)}</td>
          <td class="num">${belge.kalem_sayisi != null ? belge.kalem_sayisi : '-'}</td>
          <td>${hucre(belge.mesaj)}</td>`;
        if (belge.document_id) {
          satir.classList.remove('no-click');
          satir.addEventListener('click', () => openDetail(belge.document_id));
          satir.title = 'Detayı aç';
        }
        if (belge.durum === 'BASARILI' || belge.durum === 'SUPHELI') basarili++;
      });
    } catch (err) {
      tr.innerHTML = `<td>${esc(f.name)}</td><td><span class="badge badge-HATALI">HATA</span></td><td colspan="3">${esc(err.message)}</td>`;
    }
  }

  yukleDevam = false;
  toast(`Yükleme bitti: ${basarili}/${pdfler.length} belge kaydedildi.`, basarili === 0);
  loadBelgeler(0);
  refreshGozdenBadge();
}

// --- Gözden geçir sekmesi ------------------------------------------------

async function loadGozdenGecir() {
  const el = $('gozden-sonuc');
  el.innerHTML = '<p class="info">Yükleniyor…</p>';
  try {
    const [json1, json2] = await Promise.all([
      api('/api/documents?' + new URLSearchParams({ parse_durumu: 'SUPHELI', limit: 200 })),
      api('/api/documents?' + new URLSearchParams({ parse_durumu: 'HATALI', limit: 200 })),
    ]);

    const data = [...json1.data, ...json2.data];
    guncelleGozdenBadge(json1.total + json2.total);
    if (!data.length) { el.innerHTML = '<p class="empty">Harika! Gözden geçirilecek belge yok.</p>'; return; }

    el.innerHTML = `
      <p class="info">${json1.total + json2.total} belge gözden geçirme bekliyor.</p>
      <table>
        <thead><tr><th>#</th><th>Tarih</th><th>Belge No</th><th>Satıcı</th><th>Kaynak Dosya</th><th>Durum</th><th>Not</th></tr></thead>
        <tbody>
          ${data.map((d) => `
            <tr data-id="${d.id}">
              <td>${d.id}</td>
              <td>${hucre(d.duzenleme_tarihi)}</td>
              <td>${hucre(d.belge_no)}</td>
              <td>${hucre(d.satici_unvan)}</td>
              <td class="kaynak">${hucre(d.kaynak_dosya)}</td>
              <td><span class="badge badge-${esc(d.parse_durumu)}">${esc(d.parse_durumu)}</span></td>
              <td>${hucre(d.parse_notu)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    el.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => openDetail(parseInt(tr.dataset.id, 10)));
    });
  } catch (err) {
    el.innerHTML = `<p class="error">Yüklenemedi: ${esc(err.message)}</p>`;
  }
}

function guncelleGozdenBadge(sayi) {
  const b = $('gozden-badge');
  if (sayi > 0) { b.textContent = sayi; b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}

async function refreshGozdenBadge() {
  try {
    const [j1, j2] = await Promise.all([
      api('/api/documents?' + new URLSearchParams({ parse_durumu: 'SUPHELI', limit: 1 })),
      api('/api/documents?' + new URLSearchParams({ parse_durumu: 'HATALI', limit: 1 })),
    ]);
    guncelleGozdenBadge(j1.total + j2.total);
  } catch { /* rozet kritik değil */ }
}

// --- Belge detay modal ---------------------------------------------------

let currentDoc = null;

async function openDetail(id) {
  try {
    const d = await api(`/api/documents/${id}`);
    currentDoc = d;
    $('modal-icerik').innerHTML = editMode ? renderDetailEdit(d) : renderDetail(d);
    $('modal-overlay').classList.remove('hidden');
  } catch (err) {
    toast(err.message, true);
  }
}

$('modal-kapat').addEventListener('click', closeModal);
$('modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'modal-overlay') closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal-overlay').classList.contains('hidden')) closeModal();
});
function closeModal() {
  $('modal-overlay').classList.add('hidden');
  currentDoc = null;
}

// Listeleri sessizce tazele (modal işlemlerinden sonra)
function refreshArkaplan() {
  loadBelgeler(currentPage);
  if (aktifTab === 'gozden-gecir') loadGozdenGecir();
  else refreshGozdenBadge();
}

// --- Salt-okunur detay ---

function renderDetail(d) {
  const field = (label, val) => val != null && val !== ''
    ? `<dt>${esc(label)}</dt><dd>${esc(String(val))}</dd>` : '';

  return `
    <h2 class="modal-baslik">${esc(d.belge_tipi)} — ${hucre(d.belge_no !== null ? d.belge_no : (d.ettn || '#' + d.id))}
      <span class="badge badge-${esc(d.parse_durumu)}">${esc(d.parse_durumu)}</span>
    </h2>
    <div class="detail-grid">
      ${field('Düzenleme Tarihi', d.duzenleme_tarihi)}
      ${field('Düzenleme Zamanı', d.duzenleme_zamani)}
      ${field('Senaryo', d.senaryo)}
      ${field('Fatura Tipi', d.fatura_tipi)}
      ${field('ETTN', d.ettn)}
      ${field('Parse Notu', d.parse_notu)}
    </div>

    <p class="detail-section-title">Satıcı</p>
    <div class="detail-grid">
      ${field('Unvan', d.satici_unvan)}
      ${field('VKN/TCKN', d.satici_vkn_tckn)}
      ${field('Vergi Dairesi', d.satici_vergi_dairesi)}
      ${field('Adres', d.satici_adres)}
      ${field('E-Posta', d.satici_eposta)}
      ${field('Telefon', d.satici_telefon)}
    </div>

    <p class="detail-section-title">Alıcı</p>
    <div class="detail-grid">
      ${field('Unvan', d.alici_unvan)}
      ${field('VKN/TCKN', d.alici_vkn_tckn)}
      ${field('Vergi Dairesi', d.alici_vergi_dairesi)}
      ${field('Adres', d.alici_adres)}
      ${field('E-Posta', d.alici_eposta)}
      ${field('Telefon', d.alici_telefon)}
    </div>

    <p class="detail-section-title">Tutarlar</p>
    <div class="detail-grid">
      ${field('Mal/Hizmet Toplam', d.mal_hizmet_toplam_tutari != null ? fmtPara(d.mal_hizmet_toplam_tutari) + ' TL' : null)}
      ${field('Hesaplanan KDV', d.hesaplanan_kdv_toplam != null ? fmtPara(d.hesaplanan_kdv_toplam) + ' TL' : null)}
      ${field('Vergiler Dahil Toplam', d.vergiler_dahil_toplam_tutar != null ? fmtPara(d.vergiler_dahil_toplam_tutar) + ' TL' : null)}
      ${field('Ödenecek Tutar', d.odenecek_tutar != null ? fmtPara(d.odenecek_tutar) + ' TL' : null)}
    </div>

    ${d.notlar ? `<p class="detail-section-title">Notlar</p><p class="notlar">${esc(d.notlar)}</p>` : ''}

    <p class="detail-section-title">Kalemler (${d.items.length})</p>
    ${d.items.length ? `
      <table>
        <thead>
          <tr><th>#</th><th>Açıklama</th><th class="num">Miktar</th><th>Birim</th><th class="num">Birim Fiyat</th><th class="num">KDV%</th><th class="num">KDV Tutarı</th><th class="num">Tutar</th><th class="num satis-fiyati" title="Kar oranına göre tarayıcıda hesaplanır; kayıtlı veri değildir">Satış Fiyatı</th></tr>
        </thead>
        <tbody>
          ${d.items.map((i) => {
            const satisFiyati = i.birim_fiyat != null ? i.birim_fiyat * (1 + profitMargin / 100) : null;
            return `
              <tr class="no-click">
                <td>${hucre(i.sira_no)}</td>
                <td>${hucre(i.aciklama)}</td>
                <td class="num">${i.miktar != null ? esc(String(i.miktar)) : '-'}</td>
                <td>${hucre(i.birim)}</td>
                <td class="num">${i.birim_fiyat != null ? fmtPara(i.birim_fiyat) : '-'}</td>
                <td class="num">${i.kdv_orani != null ? '%' + esc(String(i.kdv_orani)) : '-'}</td>
                <td class="num">${i.kdv_tutari != null ? fmtPara(i.kdv_tutari) : '-'}</td>
                <td class="num">${i.mal_hizmet_tutari != null ? fmtPara(i.mal_hizmet_tutari) : '-'}</td>
                <td class="num satis-fiyati">${satisFiyati != null ? fmtPara(satisFiyati) : '-'}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>` : '<p class="empty">Kalem bulunamadı.</p>'}

    ${d.kaynak_dosya ? `<p class="kaynak-dosya">Kaynak: ${esc(d.kaynak_dosya)}</p>` : ''}
  `;
}

// --- Düzenlenebilir detay ---

function inputAlan(label, f, val, opts = {}) {
  const tip = opts.tip || 'text';
  const v = val == null ? '' : esc(String(val));
  return `
    <label class="edit-alan">
      <span>${esc(label)}</span>
      <input type="${tip}" data-f="${f}" value="${v}" ${opts.ph ? `placeholder="${esc(opts.ph)}"` : ''} />
    </label>`;
}

function renderDetailEdit(d) {
  const durumSecenek = ['BASARILI', 'SUPHELI', 'HATALI']
    .map((s) => `<option value="${s}" ${d.parse_durumu === s ? 'selected' : ''}>${s}</option>`).join('');
  const tipSecenek = ['FATURA', 'IRSALIYE']
    .map((s) => `<option value="${s}" ${d.belge_tipi === s ? 'selected' : ''}>${s}</option>`).join('');

  return `
    <h2 class="modal-baslik">✏️ ${esc(d.belge_tipi)} #${d.id} düzenleniyor
      <span class="badge badge-${esc(d.parse_durumu)}">${esc(d.parse_durumu)}</span>
    </h2>

    <div class="edit-uyari">Düzenleme modu açık — yapılan değişiklikler doğrudan veritabanına yazılır.</div>

    <div id="edit-header">
      <p class="detail-section-title">Belge Başlığı</p>
      <div class="edit-grid">
        <label class="edit-alan"><span>Belge Tipi</span><select data-f="belge_tipi">${tipSecenek}</select></label>
        ${inputAlan('Belge No', 'belge_no', d.belge_no)}
        ${inputAlan('ETTN', 'ettn', d.ettn)}
        ${inputAlan('Düzenleme Tarihi', 'duzenleme_tarihi', d.duzenleme_tarihi, { tip: 'date' })}
        ${inputAlan('Düzenleme Zamanı', 'duzenleme_zamani', d.duzenleme_zamani, { ph: 'SS:DD:SS' })}
        ${inputAlan('Senaryo', 'senaryo', d.senaryo)}
        ${inputAlan('Fatura Tipi', 'fatura_tipi', d.fatura_tipi)}
        ${inputAlan('Mal/Hizmet Toplam (TL)', 'mal_hizmet_toplam_tutari', d.mal_hizmet_toplam_tutari)}
        ${inputAlan('Hesaplanan KDV (TL)', 'hesaplanan_kdv_toplam', d.hesaplanan_kdv_toplam)}
        ${inputAlan('Vergiler Dahil Toplam (TL)', 'vergiler_dahil_toplam_tutar', d.vergiler_dahil_toplam_tutar)}
        ${inputAlan('Ödenecek Tutar (TL)', 'odenecek_tutar', d.odenecek_tutar)}
        <label class="edit-alan"><span>Parse Durumu</span><select data-f="parse_durumu">${durumSecenek}</select></label>
        ${inputAlan('Parse Notu', 'parse_notu', d.parse_notu)}
        ${inputAlan('Notlar', 'notlar', d.notlar)}
      </div>
      <button class="btn-yesil" data-action="header-kaydet">Başlığı Kaydet</button>
    </div>

    ${tarafEditBlok('Satıcı', 'satici', d)}
    ${tarafEditBlok('Alıcı', 'alici', d)}

    <p class="detail-section-title">Kalemler (${d.items.length})</p>
    <table id="edit-items-table">
      <thead>
        <tr><th>#</th><th>Açıklama</th><th>Miktar</th><th>Birim</th><th>Birim Fiyat</th><th>KDV%</th><th>KDV Tutarı</th><th>Tutar</th><th class="satis-fiyati" title="Kar oranına göre tarayıcıda hesaplanır; kayıtlı veri değildir">Satış Fiyatı</th><th></th></tr>
      </thead>
      <tbody>
        ${d.items.map((i) => kalemSatiri(i)).join('')}
      </tbody>
    </table>
    <button class="btn-kucuk" data-action="kalem-ekle" style="margin-top:8px">+ Kalem Ekle</button>

    <div class="edit-eylemler">
      <button data-action="revalidate" title="Kalem toplamlarını başlıktaki tutarlarla karşılaştırıp parse durumunu günceller">✓ Yeniden Doğrula</button>
      <button class="btn-kirmizi" data-action="belge-sil">Belgeyi Sil</button>
    </div>

    ${d.kaynak_dosya ? `<p class="kaynak-dosya">Kaynak: ${esc(d.kaynak_dosya)}</p>` : ''}
  `;
}

function tarafEditBlok(baslik, prefix, d) {
  const tarafId = d[prefix + '_id'];
  if (!tarafId) {
    return `<p class="detail-section-title">${baslik}</p><p class="info">Bu belgeye bağlı ${baslik.toLowerCase()} kaydı yok.</p>`;
  }
  return `
    <div data-taraf-blok="${tarafId}">
      <p class="detail-section-title">${baslik} <span class="info-kucuk">(düzeltme, bu tarafın geçtiği TÜM belgelere yansır)</span></p>
      <div class="edit-grid">
        ${inputAlan('Unvan', 'unvan', d[prefix + '_unvan'])}
        ${inputAlan('VKN/TCKN', 'vkn_tckn', d[prefix + '_vkn_tckn'])}
        ${inputAlan('Vergi Dairesi', 'vergi_dairesi', d[prefix + '_vergi_dairesi'])}
        ${inputAlan('Adres', 'adres', d[prefix + '_adres'])}
        ${inputAlan('E-Posta', 'eposta', d[prefix + '_eposta'])}
        ${inputAlan('Telefon', 'telefon', d[prefix + '_telefon'])}
      </div>
      <button class="btn-yesil" data-action="taraf-kaydet" data-taraf-id="${tarafId}">${baslik} Bilgisini Kaydet</button>
    </div>`;
}

function kalemSatiri(i) {
  const inp = (f, v, w) =>
    `<input type="text" data-f="${f}" value="${v == null ? '' : esc(String(v))}" style="width:${w}px" />`;
  const satisFiyati = i.birim_fiyat != null ? i.birim_fiyat * (1 + profitMargin / 100) : null;
  return `
    <tr data-item-id="${i.id || ''}" class="no-click">
      <td>${inp('sira_no', i.sira_no, 36)}</td>
      <td>${inp('aciklama', i.aciklama, 220)}</td>
      <td>${inp('miktar', i.miktar, 60)}</td>
      <td>${inp('birim', i.birim, 60)}</td>
      <td>${inp('birim_fiyat', i.birim_fiyat, 80)}</td>
      <td>${inp('kdv_orani', i.kdv_orani, 50)}</td>
      <td>${inp('kdv_tutari', i.kdv_tutari, 80)}</td>
      <td>${inp('mal_hizmet_tutari', i.mal_hizmet_tutari, 90)}</td>
      <td class="num satis-fiyati">${satisFiyati != null ? fmtPara(satisFiyati) : '-'}</td>
      <td class="row-actions">
        <button class="btn-kucuk btn-yesil" data-action="kalem-kaydet">Kaydet</button>
        <button class="btn-kucuk btn-kirmizi" data-action="kalem-sil">Sil</button>
      </td>
    </tr>`;
}

// Modal içi olay delegasyonu (düzenleme modu eylemleri)
$('modal-icerik').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn || !currentDoc) return;
  const docId = currentDoc.id;
  const action = btn.dataset.action;

  try {
    if (action === 'header-kaydet') {
      const fields = alanlariTopla($('edit-header'));
      await api(`/api/documents/${docId}`, { method: 'PATCH', body: fields });
      toast('Belge başlığı kaydedildi.');
      await openDetail(docId);
      refreshArkaplan();

    } else if (action === 'taraf-kaydet') {
      const blok = btn.closest('[data-taraf-blok]');
      const fields = alanlariTopla(blok);
      if (!fields.unvan) { toast('Unvan boş olamaz.', true); return; }
      await api(`/api/taraflar/${btn.dataset.tarafId}`, { method: 'PATCH', body: fields });
      toast('Taraf bilgisi kaydedildi.');
      await openDetail(docId);
      refreshArkaplan();

    } else if (action === 'kalem-ekle') {
      const tbody = $('edit-items-table').querySelector('tbody');
      tbody.insertAdjacentHTML('beforeend', kalemSatiri({ id: '', sira_no: currentDoc.items.length + 1 }));

    } else if (action === 'kalem-kaydet') {
      const tr = btn.closest('tr[data-item-id]');
      const fields = alanlariTopla(tr);
      if (tr.dataset.itemId) {
        await api(`/api/items/${tr.dataset.itemId}`, { method: 'PATCH', body: fields });
        toast('Kalem güncellendi.');
      } else {
        await api(`/api/documents/${docId}/items`, { method: 'POST', body: fields });
        toast('Kalem eklendi.');
      }
      await openDetail(docId);
      refreshArkaplan();

    } else if (action === 'kalem-sil') {
      const tr = btn.closest('tr[data-item-id]');
      if (!tr.dataset.itemId) { tr.remove(); return; }   // henüz kaydedilmemiş satır
      if (!confirm('Bu kalem silinsin mi?')) return;
      await api(`/api/items/${tr.dataset.itemId}`, { method: 'DELETE' });
      toast('Kalem silindi.');
      await openDetail(docId);
      refreshArkaplan();

    } else if (action === 'revalidate') {
      const sonuc = await api(`/api/documents/${docId}/revalidate`, { method: 'POST' });
      toast(sonuc.parse_durumu === 'BASARILI'
        ? 'Doğrulama başarılı: tutarlar tutuyor.'
        : 'Hâlâ şüpheli: ' + sonuc.notlar.join('; '), sonuc.parse_durumu !== 'BASARILI');
      await openDetail(docId);
      refreshArkaplan();

    } else if (action === 'belge-sil') {
      if (!confirm(`#${docId} numaralı belge ve tüm kalemleri kalıcı olarak silinecek. Emin misiniz?`)) return;
      await api(`/api/documents/${docId}`, { method: 'DELETE' });
      toast('Belge silindi.');
      closeModal();
      refreshArkaplan();
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// --- İlk yükleme ---------------------------------------------------------

loadBelgeler(0);
refreshGozdenBadge();
