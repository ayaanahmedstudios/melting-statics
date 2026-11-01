const $ = id => document.getElementById(id);

/* Logo container naturally expands & contracts with the wave */
[...'Thawing Statics'].forEach((ch, n) => {
  const i = document.createElement('i');
  i.textContent = ch;
  i.style.setProperty('--i', n);
  $('logo').appendChild(i);
});

const PY = `
import io, json, hashlib, logging
logging.getLogger("fontTools").setLevel(logging.ERROR)
from fontTools.ttLib import TTFont
from fontTools import varLib
from fontTools.designspaceLib import DesignSpaceDocument, SourceDescriptor, InstanceDescriptor

FONTS = {}
WDTH = {1: 50, 2: 62.5, 3: 75, 4: 87.5, 5: 100, 6: 112.5, 7: 125, 8: 150, 9: 200}
AXN = {"wght": "Weight", "wdth": "Width"}

def inspect(fid, raw_bytes):
    f = TTFont(io.BytesIO(bytes(raw_bytes)))
    f.flavor = None
    if 'fvar' in f:
        return json.dumps({"error": "This is already a variable font."})
    if 'glyf' not in f and 'CFF ' not in f:
        return json.dumps({"error": "No outlines found in this font."})
    FONTS[fid] = f
    n = f['name']
    os2 = f['OS/2'] if 'OS/2' in f else None
    order = f.getGlyphOrder()
    fam = n.getDebugName(16) or n.getDebugName(1) or "Untitled font"
    sty = n.getDebugName(17) or n.getDebugName(2) or "Regular"
    italic = bool(f['head'].macStyle & 2) or bool(os2 is not None and (os2.fsSelection & 1))
    return json.dumps({
        "family": fam,
        "style": sty,
        "wght": (os2.usWeightClass if os2 is not None and os2.usWeightClass else 400),
        "wdth": WDTH.get(os2.usWidthClass if os2 is not None else 5, 100),
        "italic": italic,
        "ext": "otf" if 'CFF ' in f else "ttf",
        "upm": f['head'].unitsPerEm,
        "glyphs": len(order),
        "sig": hashlib.md5(",".join(order).encode()).hexdigest()[:8],
        "copyright": n.getDebugName(0) or "",
        "license": n.getDebugName(13) or "",
        "licenseUrl": n.getDebugName(14) or ""
    })

def build(spec_json, fmts_json):
    spec = json.loads(spec_json)
    fmts = json.loads(fmts_json)
    tags = spec["axes"]
    ms = spec["masters"]
    dflt = spec["default"]
    fam = spec["family"]
    ds = DesignSpaceDocument()
    for t in tags:
        vals = [m[t] for m in ms]
        ds.addAxisDescriptor(name=AXN[t], tag=t, minimum=min(vals), default=dflt[t], maximum=max(vals))
    for m in ms:
        loc = {AXN[t]: m[t] for t in tags}
        s = SourceDescriptor()
        s.font = FONTS[m["id"]]
        s.familyName = fam
        s.styleName = m["name"]
        s.location = loc
        ds.addSource(s)
        i = InstanceDescriptor()
        i.familyName = fam
        i.styleName = m["name"]
        i.location = loc
        ds.addInstance(i)
    try:
        res = varLib.build(ds)
    except Exception as e:
        raise ValueError(type(e).__name__ + ": " + str(e))
    vf = res[0] if isinstance(res, tuple) else res

    sub = "Italic" if spec["ital"] else "Regular"
    ps = fam.replace(" ", "") + "-" + sub
    nt = vf["name"]
    for pid, eid, lid in ((3, 1, 0x409), (1, 0, 0)):
        for nid, val in ((1, fam), (2, sub), (4, fam + " " + sub), (6, ps), (16, fam), (17, sub)):
            nt.setName(val, nid, pid, eid, lid)

    out = []
    for fm in fmts:
        vf.flavor = "woff2" if fm == "woff2" else None
        buf = io.BytesIO()
        vf.save(buf)
        out.append(buf.getvalue())
    return out
`;

const AXN = { wght: 'Weight', wdth: 'Width' };

let py = null, pyPromise = null;
let items = [], nextId = 1;
let built = null, curIdx = 0, cur = {}, resultURL = null, resultN = 0;

const faceStyle = document.createElement('style');
const resultStyle = document.createElement('style');
document.head.append(faceStyle, resultStyle);

const msg = (t, err) => {
  ['msg', 'wmsg'].forEach(id => { $(id).textContent = t || ''; $(id).className = err ? 'err' : ''; });
};
const fvs = c => Object.entries(c).map(([k, v]) => `"${k}" ${v}`).join(',');
const num = v => Number.isInteger(v) ? v : +v.toFixed(2);
const noop = () => {};
const explain = e => {
  const l = String(e?.message || e).trim().split('\n').map(s => s.trim()).filter(Boolean);
  return l[l.length - 1] || 'Unknown error.';
};
const cleanFam = s => s.replace(/\s+(\d+pt\s+)?(Thin|Hairline|ExtraLight|UltraLight|Light|Regular|Book|Medium|SemiBold|DemiBold|Bold|ExtraBold|UltraBold|Black|Heavy|Italic|Oblique)(\s.*)?$/i, '').replace(/\s+\d+pt$/i, '').trim() || s;

addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault();
  if (!$('work').classList.contains('on')) return;
  const fs = [...(e.dataTransfer?.files || [])];
  if (fs.length) addFiles(fs);
});

function initPyodide() {
  if (pyPromise) return pyPromise;
  pyPromise = (async () => {
    if (typeof WebAssembly !== 'object') throw new Error('WebAssembly is required.');
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/pyodide.js';
      s.onload = res;
      s.onerror = () => rej(new Error('Could not download converter.'));
      document.head.appendChild(s);
    });
    py = await loadPyodide({ stdout: noop, stderr: noop });
    await py.loadPackage('micropip', { messageCallback: noop, errorCallback: noop });
    await py.runPythonAsync("import micropip\nawait micropip.install(['fonttools', 'brotli'])");
    await py.runPythonAsync(PY);
    return py;
  })();
  return pyPromise;
}

if ('requestIdleCallback' in window) requestIdleCallback(() => initPyodide().catch(noop));
else setTimeout(() => initPyodide().catch(noop), 800);

const drop = $('drop');
['dragover', 'dragenter'].forEach(t => drop.addEventListener(t, () => drop.classList.add('over')));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, () => drop.classList.remove('over')));
drop.addEventListener('drop', e => { const fs = [...(e.dataTransfer?.files || [])]; if (fs.length) addFiles(fs); });
['file', 'file2'].forEach(id => $(id).addEventListener('change', e => {
  const fs = [...e.target.files];
  e.target.value = '';
  if (fs.length) addFiles(fs);
}));

$('reset').onclick = () => {
  items.forEach(it => it.url && URL.revokeObjectURL(it.url));
  items = [];
  built = null;
  faceStyle.textContent = '';
  $('work').classList.remove('on');
  $('home').style.display = '';
  msg('');
};

async function addFiles(files) {
  drop.classList.add('wait');
  const errs = [];
  try {
    if (!py) {
      msg('Starting converter…');
      await initPyodide();
    }
  } catch (e) {
    msg(e?.message || 'Could not start the converter.', true);
    drop.classList.remove('wait');
    return;
  }
  const before = items.length;
  for (const file of files) {
    if (items.some(i => i.name === file.name && i.size === file.size)) continue;
    try {
      msg(`Reading ${file.name}…`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const id = nextId++;
      const info = JSON.parse(py.globals.get('inspect')(id, bytes));
      if (info.error) { errs.push(`${file.name}: ${info.error}`); continue; }
      info.family = cleanFam(info.family);
      items.push({ id, name: file.name, size: file.size, bytes, info, on: true, wght: info.wght, wdth: info.wdth });
    } catch (e) {
      errs.push(`${file.name}: could not be read as a font.`);
    }
  }
  drop.classList.remove('wait');
  msg(errs.join(' '), !!errs.length);
  if (!items.length) return;
  if (items.length > before) {
    items.forEach(it => { if (!it.url) it.url = URL.createObjectURL(new Blob([it.bytes])); });
    faceStyle.textContent = items.map(it => `@font-face{font-family:"M${it.id}";src:url(${it.url})}`).join('\n');
    renderLicense();
    invalidate();
    drawList();
  }
  $('home').style.display = 'none';
  $('work').classList.add('on');
}

/* Group chosen styles into one variable font per family + italic */
function computeGroups() {
  const map = new Map();
  items.forEach(it => {
    const k = it.info.family + '|' + it.info.italic;
    if (!map.has(k)) map.set(k, { key: k, family: it.info.family, italic: it.info.italic, members: [] });
    map.get(k).members.push(it);
  });
  return [...map.values()].map(g => {
    const ms = g.active = g.members.filter(m => m.on);
    g.notes = [];
    g.block = '';
    g.axes = ['wght', 'wdth'].filter(t => new Set(ms.map(m => m[t])).size > 1);
    g.ext = ms[0]?.info.ext || 'ttf';
    if (!ms.length) return g;
    const dist = m => Math.abs(m.wght - 400) + Math.abs(m.wdth - 100) * 4;
    const dm = ms.reduce((b, m) => dist(m) < dist(b) ? m : b, ms[0]);
    g.default = { wght: dm.wght, wdth: dm.wdth };
    g.range = {};
    ['wght', 'wdth'].forEach(t => g.range[t] = [Math.min(...ms.map(m => m[t])), Math.max(...ms.map(m => m[t]))]);
    if (ms.length < 2) g.block = 'Needs at least two styles to blend.';
    else if (!g.axes.length) g.block = 'All styles share the same weight and width. Edit the numbers so they differ.';
    else if (new Set(ms.map(m => m.wght + '/' + m.wdth)).size < ms.length) g.block = 'Two styles share the same weight and width. Edit one.';
    else if (new Set(ms.map(m => m.info.ext)).size > 1) g.block = 'Mixes TrueType and CFF outlines.';
    else if (new Set(ms.map(m => m.info.upm)).size > 1) g.block = 'Styles use different units per em.';
    else if (new Set(ms.map(m => m.info.sig)).size > 1) g.notes.push('Glyph sets differ between these files, so blending will probably fail.');
    return g;
  });
}

function invalidate() {
  built = null;
  const first = items.find(i => i.on) || items[0];
  if (first) $('sample').style.fontFamily = `"M${first.id}", sans-serif`;
  $('sample').style.fontVariationSettings = '';
  drawAxes();
}

function showPreview(idx) {
  curIdx = idx;
  const g = built[idx];
  if (resultURL) URL.revokeObjectURL(resultURL);
  resultURL = URL.createObjectURL(new Blob([g.data]));
  g.face = 'B' + (++resultN);
  resultStyle.textContent = `@font-face{font-family:"${g.face}";src:url(${resultURL});font-weight:1 1000;font-stretch:25% 200%}`;
  cur = {};
  g.axes.forEach(a => cur[a.tag] = a.def);
  drawAxes();
}

function setCur(tag, v) {
  cur[tag] = v;
  $('sample').style.fontFamily = `"${built[curIdx].face}", sans-serif`;
  $('sample').style.fontVariationSettings = fvs(cur);
}

function drawAxes() {
  const box = $('axes');
  box.textContent = '';
  const sel = $('which');
  if (!built) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Export to preview the variable font here.';
    box.appendChild(p);
    sel.style.display = 'none';
    $('resetAxes').style.visibility = 'hidden';
    return;
  }
  $('resetAxes').style.visibility = '';
  sel.textContent = '';
  built.forEach((b, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = b.label;
    sel.appendChild(o);
  });
  sel.value = curIdx;
  sel.style.display = built.length > 1 ? '' : 'none';

  const g = built[curIdx];
  g.axes.forEach(a => {
    const step = (a.max - a.min) > 20 ? 1 : 0.01;
    const d = document.createElement('div'); d.className = 'axis';
    const top = document.createElement('div'); top.className = 'top';
    const lab = document.createElement('span'); lab.textContent = a.name;
    const sm = document.createElement('small'); sm.textContent = a.tag; lab.appendChild(sm);

    const n = document.createElement('input');
    Object.assign(n, { type: 'number', min: a.min, max: a.max, step, value: num(cur[a.tag]) });
    const r = document.createElement('input');
    Object.assign(r, { type: 'range', min: a.min, max: a.max, step, value: cur[a.tag] });

    r.oninput = () => { n.value = num(+r.value); setCur(a.tag, +r.value); };
    n.onchange = () => {
      const v = Math.min(a.max, Math.max(a.min, +n.value || a.def));
      n.value = num(v); r.value = v; setCur(a.tag, v);
    };
    top.append(lab, n); d.append(top, r); box.appendChild(d);
  });
  $('sample').style.fontFamily = `"${g.face}", sans-serif`;
  $('sample').style.fontVariationSettings = fvs(cur);
}

$('which').onchange = e => showPreview(+e.target.value);
$('resetAxes').onclick = () => {
  if (!built) return;
  built[curIdx].axes.forEach(a => cur[a.tag] = a.def);
  drawAxes();
};

function drawList() {
  const L = $('list');
  L.textContent = '';
  $('family').textContent = [...new Set(items.map(i => i.info.family))].join(' + ');
  $('nativeExt').textContent = [...new Set(items.map(i => i.info.ext.toUpperCase()))].join('/') || 'TTF';

  computeGroups().forEach(g => {
    const head = document.createElement('div');
    head.className = 'grp';
    const b = document.createElement('b');
    b.textContent = `${g.family} · ${g.italic ? 'Italic' : 'Roman'}`;
    const meta = document.createElement('div');
    meta.className = 'gmeta';
    if (!g.active.length) meta.textContent = 'No styles selected.';
    else if (g.axes.length) {
      meta.textContent = g.axes.map(t => `${t} ${num(g.range[t][0])}–${num(g.range[t][1])}`).join(' · ') + ` · default ${g.axes.map(t => num(g.default[t])).join('/')}`;
    }
    head.append(b, meta);
    L.appendChild(head);
    if (g.block && g.active.length) {
      const w = document.createElement('div'); w.className = 'warn bad'; w.textContent = g.block; L.appendChild(w);
    }
    g.notes.forEach(t => {
      const w = document.createElement('div'); w.className = 'warn'; w.textContent = t; L.appendChild(w);
    });

    g.members.forEach(it => {
      const r = document.createElement('div');
      r.className = 'row' + (it.on ? '' : ' off');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = it.on;

      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = it.info.style;
      nm.style.fontFamily = `"M${it.id}", sans-serif`;
      nm.title = it.name;

      const mk = (key, title, fallback) => {
        const n = document.createElement('input');
        Object.assign(n, { type: 'number', className: 'num', min: 1, max: 1000, step: 'any', value: num(it[key]), title });
        n.onclick = e => e.stopPropagation();
        n.onchange = () => {
          it[key] = Math.min(1000, Math.max(1, +n.value || fallback));
          invalidate(); drawList();
        };
        return n;
      };

      const x = document.createElement('button');
      x.type = 'button'; x.className = 'x'; x.textContent = '×'; x.title = 'Remove';

      cb.onclick = e => e.stopPropagation();
      cb.onchange = () => { it.on = cb.checked; invalidate(); drawList(); };
      x.onclick = e => {
        e.stopPropagation();
        if (it.url) URL.revokeObjectURL(it.url);
        items = items.filter(i => i !== it);
        if (!items.length) { $('reset').onclick(); return; }
        invalidate(); drawList();
      };
      r.onclick = () => {
        $('sample').style.fontFamily = `"M${it.id}", sans-serif`;
        $('sample').style.fontVariationSettings = '';
      };

      r.append(cb, nm, mk('wght', 'Weight', it.info.wght), mk('wdth', 'Width', it.info.wdth), x);
      L.appendChild(r);
    });
  });
  sync();
}

const sync = () => {
  const ok = computeGroups().filter(g => g.active.length && !g.block);
  const hasFmt = $('fNative').checked || $('fW2').checked;
  $('go').textContent = ok.length ? `Export (${ok.length})` : 'Export';
  $('go').disabled = !(ok.length && hasFmt && $('agree').checked);
};

$('agree').onchange = sync;
$('fNative').onchange = sync;
$('fW2').onchange = sync;
$('selAll').onclick = () => { items.forEach(i => i.on = true); invalidate(); drawList(); };
$('selNone').onclick = () => { items.forEach(i => i.on = false); invalidate(); drawList(); };

function renderLicense() {
  $('agree').checked = false;
  const lic = $('lic'); lic.textContent = '';
  const f = items.find(i => i.info.license || i.info.copyright || i.info.licenseUrl)?.info || items[0].info;
  const parts = [f.license, f.copyright].filter(Boolean).join(' · ');
  lic.textContent = parts ? (parts.length > 140 ? parts.slice(0, 140) + '…' : parts) : 'No license metadata in these fonts.';
  if (f.licenseUrl && /^https?:\/\//i.test(f.licenseUrl)) {
    const a = document.createElement('a');
    a.href = f.licenseUrl; a.textContent = ' License link ↗'; a.target = '_blank'; a.rel = 'noopener';
    lic.appendChild(a);
  }

  const w = $('licwarn'); w.textContent = '';
  const warn = t => { const d = document.createElement('div'); d.className = 'warn'; d.textContent = t; w.appendChild(d); };
  const all = items.map(i => i.info.copyright + ' ' + i.info.license + ' ' + i.info.licenseUrl).join(' ');
  if (parts && !/open font license|\bOFL\b|apache|\bMIT\b|public domain|ubuntu font/i.test(all)) {
    warn('Doesn’t look like an open license. Commercial fonts usually forbid modification.');
  }
  if (/reserved font name/i.test(all)) {
    warn('Reserved Font Name declared. Rename files before sharing.');
  }
}

const readme = (groups) => `Variable fonts made with Thawing Statics.\n\n` + groups.map(g => {
  const i = g.active[0].info;
  return `${g.family}${g.italic ? ' Italic' : ''}\nMasters: ${g.active.map(m => `${m.info.style} (wght ${num(m.wght)}, wdth ${num(m.wdth)})`).join(', ')}\nSource files: ${g.active.map(m => m.name).join(', ')}\nCopyright: ${i.copyright || 'not stated'}\nLicense: ${i.license || 'not stated'}\nLink: ${i.licenseUrl || 'not stated'}\n`;
}).join('\n');

$('go').onclick = async () => {
  const groups = computeGroups().filter(g => g.active.length && !g.block);
  const fmts = [];
  if ($('fNative').checked) fmts.push('native');
  if ($('fW2').checked) fmts.push('woff2');
  if (!groups.length || !fmts.length) return;

  $('go').disabled = true;
  msg('');
  const out = [], results = [];
  try {
    const build = py.globals.get('build');
    for (const [gi, g] of groups.entries()) {
      $('go').textContent = `${gi + 1}/${groups.length}…`;
      await new Promise(r => setTimeout(r, 30));
      const spec = {
        family: g.family, ital: g.italic, axes: g.axes, default: g.default,
        masters: g.active.map(m => ({ id: m.id, name: m.info.style, wght: m.wght, wdth: m.wdth }))
      };
      let list;
      try {
        const proxy = build(JSON.stringify(spec), JSON.stringify(fmts));
        list = proxy.toJs({ create_proxies: false });
        proxy.destroy();
      } catch (e) {
        throw new Error(`${g.family}${g.italic ? ' Italic' : ''}: ${explain(e)}`);
      }
      const base = g.family.replace(/\W+/g, '') + (g.italic ? '-Italic' : '') + '[' + g.axes.join(',') + ']';
      fmts.forEach((f, i) => out.push({ name: base + '.' + (f === 'woff2' ? 'woff2' : g.ext), data: list[i] }));
      results.push({
        label: g.family + (g.italic ? ' Italic' : ''),
        data: list[0],
        axes: g.axes.map(t => ({ tag: t, name: AXN[t], min: g.range[t][0], def: g.default[t], max: g.range[t][1] }))
      });
    }

    let blob, name;
    if (out.length === 1) {
      blob = new Blob([out[0].data]);
      name = out[0].name;
    } else {
      const z = new JSZip();
      out.forEach(o => z.file(o.name, o.data));
      z.file('README.txt', readme(groups));
      blob = await z.generateAsync({ type: 'blob' });
      name = groups[0].family.replace(/\W+/g, '') + '-variable.zip';
    }
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    built = results;
    showPreview(0);
    msg('Done. Try the sliders under Axes.');
  } catch (e) {
    msg('Couldn’t blend these styles. ' + explain(e) + ' Static fonts need matching glyph names and outline points to become variable.', true);
  }
  sync();
};
