const $ = id => document.getElementById(id);

/* Logo container naturally expands & contracts with the wave */
[...'Melting Statics'].forEach((ch, n) => {
  const i = document.createElement('i');
  i.textContent = ch;
  i.style.setProperty('--i', n);
  $('logo').appendChild(i);
});

/* ---------- Python (runs in a background worker, so the page never freezes) ---------- */
const PY = `import io, json, hashlib, logging
logging.getLogger("fontTools").setLevel(logging.ERROR)
from fontTools.ttLib import TTFont
from fontTools import varLib, subset
from fontTools.designspaceLib import DesignSpaceDocument, SourceDescriptor, InstanceDescriptor
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.basePen import BasePen
import copy

RAW = {}
LAST = "{}"
WDTH = {1: 50, 2: 62.5, 3: 75, 4: 87.5, 5: 100, 6: 112.5, 7: 125, 8: 150, 9: 200}
AXN = {"wght": "Weight", "wdth": "Width"}

def load(fid):
    return TTFont(io.BytesIO(RAW[fid]))

def inspect(fid, raw_bytes):
    raw = bytes(raw_bytes)
    f = TTFont(io.BytesIO(raw))
    if 'fvar' in f:
        return json.dumps({"error": "This is already a variable font."})
    if 'glyf' not in f and 'CFF ' not in f:
        return json.dumps({"error": "No outlines found in this font."})
    RAW[fid] = raw
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
        "copyright": n.getDebugName(0) or "",
        "license": n.getDebugName(13) or "",
        "licenseUrl": n.getDebugName(14) or ""
    })

def fix_os2(f):
    o = f['OS/2'] if 'OS/2' in f else None
    if o is None:
        return
    if o.version < 2 or not hasattr(o, 'sCapHeight'):
        asc = f['hhea'].ascent
        o.sxHeight = getattr(o, 'sxHeight', 0) or int(asc * 0.5)
        o.sCapHeight = getattr(o, 'sCapHeight', 0) or int(asc * 0.7)
        o.usDefaultChar = getattr(o, 'usDefaultChar', 0)
        o.usBreakChar = getattr(o, 'usBreakChar', 32)
        o.usMaxContext = getattr(o, 'usMaxContext', 0)
        o.version = max(o.version, 2)

def make(fonts, spec):
    for f in fonts:
        fix_os2(f)
    ds = DesignSpaceDocument()
    for t in spec["axes"]:
        vals = [m[t] for m in spec["masters"]]
        ds.addAxisDescriptor(name=AXN[t], tag=t, minimum=min(vals), default=spec["default"][t], maximum=max(vals))
    for m, font in zip(spec["masters"], fonts):
        loc = {AXN[t]: m[t] for t in spec["axes"]}
        s = SourceDescriptor()
        s.font = font
        s.familyName = spec["family"]
        s.styleName = m["name"]
        s.location = loc
        ds.addSource(s)
        i = InstanceDescriptor()
        i.familyName = spec["family"]
        i.styleName = m["name"]
        i.location = loc
        ds.addInstance(i)
    res = varLib.build(ds)
    return res[0] if isinstance(res, tuple) else res

class L2C(BasePen):
    """Redraws straight lines as (exactly straight) cubic curves so line/curve mismatches line up."""
    def __init__(self, out):
        super().__init__(None)
        self.out = out
    def _moveTo(self, p): self.out.moveTo(p)
    def _lineTo(self, p):
        a = self._getCurrentPoint()
        self.out.curveTo((a[0] + (p[0] - a[0]) / 3, a[1] + (p[1] - a[1]) / 3), (a[0] + 2 * (p[0] - a[0]) / 3, a[1] + 2 * (p[1] - a[1]) / 3), p)
    def _curveToOne(self, a, b, c): self.out.curveTo(a, b, c)
    def _closePath(self): self.out.closePath()
    def _endPath(self): self.out.endPath()

def nsig(gs, gn):
    p = RecordingPen()
    gs[gn].draw(p)
    return tuple(("curveTo", 3) if op == "lineTo" else (op, a[0] if op == "addComponent" else len(a)) for op, a in p.value)

def sig(gs, gn):
    p = RecordingPen()
    gs[gn].draw(p)
    return tuple((op, a[0] if op == "addComponent" else len(a)) for op, a in p.value)

def put(f, g, rec, adv, l2c=False):
    cs = f['CFF '].cff.topDictIndex[0].CharStrings
    old = cs[g]
    pen = T2CharStringPen(adv, None)
    rec.replay(L2C(pen) if l2c else pen)
    cs[g] = pen.getCharString(private=old.private, globalSubrs=old.globalSubrs)

def record(gs, g):
    r = RecordingPen()
    gs[g].draw(r)
    return r

def repair(fonts, di):
    """Make masters blendable: align glyph sets, then freeze glyphs whose outlines don't match."""
    d = fonts[di]
    names = list(d.getGlyphOrder())
    common = [g for g in names if all(g in set(f.getGlyphOrder()) for f in fonts)]
    dropped = len(names) - len(common)
    if dropped or any(f.getGlyphOrder() != names for f in fonts):
        opts = subset.Options()
        opts.glyph_names = True
        opts.notdef_outline = True
        opts.layout_features = ['*']
        opts.name_IDs = ['*']
        opts.name_languages = ['*']
        opts.drop_tables = ['MATH', 'FFTM']
        opts.hinting = True
        opts.legacy_kern = True
        opts.recalc_bounds = False
        opts.recalc_timestamp = False
        opts.layout_closure = False
        for _ in range(6):
            keep = set(fonts[di].getGlyphOrder())
            for f in fonts:
                keep &= set(f.getGlyphOrder())
            # a composite glyph can't stay if one of its parts is leaving
            changed = True
            while changed:
                changed = False
                for f in fonts:
                    if 'glyf' not in f:
                        continue
                    glyf = f['glyf']
                    for g in list(keep):
                        gl = glyf[g]
                        if gl.isComposite() and any(c.glyphName not in keep for c in gl.components):
                            keep.discard(g)
                            changed = True
            for f in fonts:
                if set(f.getGlyphOrder()) != keep:
                    sub = subset.Subsetter(opts)
                    sub.populate(glyphs=sorted(keep))
                    sub.subset(f)
            if all(set(f.getGlyphOrder()) == keep for f in fonts):
                break
        names = [g for g in fonts[di].getGlyphOrder()]
        for f in fonts:
            if f.getGlyphOrder() != names:
                f.reorderGlyphs(names)
    gss = [f.getGlyphSet() for f in fonts]
    base = {g: sig(gss[di], g) for g in names}
    bad = set()
    for i, gs in enumerate(gss):
        if i == di:
            continue
        for g in names:
            if g not in bad and sig(gs, g) != base[g]:
                bad.add(g)
    cff = 'CFF ' in d
    fix = set()
    if cff:
        for g in bad:
            if len({nsig(gs, g) for gs in gss}) == 1:
                fix.add(g)
        bad -= fix
        # snapshot the default's outlines before anything is rewritten
        snap = {g: record(gss[di], g) for g in bad}
        adv0 = {g: d['hmtx'][g] for g in bad}
        for i, f in enumerate(fonts):
            hm = f['hmtx']
            for g in names:
                if g in bad:
                    put(f, g, snap[g], adv0[g][0])
                    hm[g] = adv0[g]
                else:
                    put(f, g, record(gss[i], g), hm[g][0], g in fix)
        # verify; anything that still disagrees gets frozen too
        gss = [f.getGlyphSet() for f in fonts]
        late = [g for g in names if g not in bad and len({sig(gs, g) for gs in gss}) > 1]
        for g in late:
            rec, adv = record(gss[di], g), d['hmtx'][g]
            for i, f in enumerate(fonts):
                if i != di:
                    put(f, g, rec, adv[0])
                    f['hmtx'][g] = adv
        bad |= set(late)
        fix -= set(late)
    else:
        for i, f in enumerate(fonts):
            if i != di:
                for g in bad:
                    f['glyf'][g] = copy.deepcopy(d['glyf'][g])
                    f['hmtx'][g] = d['hmtx'][g]
    return sorted(bad), dropped, len(fix)

def build(spec_json):
    global LAST
    spec = json.loads(spec_json)
    ms = spec["masters"]
    di = next(i for i, m in enumerate(ms) if all(m[t] == spec["default"][t] for t in spec["axes"]))
    info = {"frozen": [], "dropped": 0}
    try:
        vf = make([load(m["id"]) for m in ms], spec)
    except Exception:
        fonts = [load(m["id"]) for m in ms]
        frozen, dropped, fixed = repair(fonts, di)
        info = {"frozen": frozen, "dropped": dropped, "fixed": fixed, "layout": False}
        try:
            vf = make(fonts, spec)
        except Exception:
            # features differ between styles: keep the default style's and drop the rest
            fonts = [load(m["id"]) for m in ms]
            repair(fonts, di)
            for i, f in enumerate(fonts):
                if i != di:
                    for t in ('GSUB', 'GPOS', 'GDEF'):
                        if t in f:
                            del f[t]
            info["layout"] = True
            vf = make(fonts, spec)

    fam = spec["family"]
    st = "Italic" if spec["ital"] else "Regular"
    nt = vf["name"]
    for pid, eid, lid in ((3, 1, 0x409), (1, 0, 0)):
        for nid, val in ((1, fam), (2, st), (4, fam + " " + st), (6, fam.replace(" ", "") + "-" + st), (16, fam), (17, st)):
            nt.setName(val, nid, pid, eid, lid)
    buf = io.BytesIO()
    vf.save(buf)
    LAST = json.dumps(info)
    return buf.getvalue()

def forget(fid):
    RAW.pop(fid, None)

def lastinfo():
    return LAST

def woff2(raw):
    f = TTFont(io.BytesIO(bytes(raw)))
    f.flavor = "woff2"
    b = io.BytesIO()
    f.save(b)
    return b.getvalue()
`;

function workerMain() {
  let py = null;
  const reply = (id, res, tr) => postMessage({ id, res }, tr || []);
  onmessage = async ({ data: { id, type, a } }) => {
    try {
      if (type === 'init') {
        importScripts('https://cdn.jsdelivr.net/pyodide/v0.29.3/full/pyodide.js');
        py = await loadPyodide({ stdout: () => {}, stderr: () => {} });
        await py.loadPackage('micropip');
        await py.runPythonAsync("import micropip\nawait micropip.install(['fonttools', 'brotli'])");
        await py.runPythonAsync(a.py);
        reply(id, true);
      } else if (type === 'inspect') {
        reply(id, py.globals.get('inspect')(a.fid, a.bytes));
      } else if (type === 'forget') {
        py.globals.get('forget')(a.fid);
        reply(id, true);
      } else if (type === 'build') {
        const p = py.globals.get('build')(a.spec);
        const data = p.toJs({ create_proxies: false });
        p.destroy();
        const info = JSON.parse(py.globals.get('lastinfo')());
        reply(id, { data, info }, [data.buffer]);
      } else if (type === 'woff2') {
        const p = py.globals.get('woff2')(a.data);
        const data = p.toJs({ create_proxies: false });
        p.destroy();
        reply(id, data, [data.buffer]);
      }
    } catch (e) {
      postMessage({ id, err: String((e && e.message) || e) });
    }
  };
}

const worker = new Worker(URL.createObjectURL(new Blob([`(${workerMain})()`], { type: 'text/javascript' })));
const pending = new Map();
let seq = 0;
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  data.err !== undefined ? p.rej(new Error(data.err)) : p.res(data.res);
};
worker.onerror = e => {
  pending.forEach(p => p.rej(new Error(e.message || 'Converter crashed.')));
  pending.clear();
};
const call = (type, a, tr) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  worker.postMessage({ id, type, a }, tr || []);
});
let readyP = null;
const ready = () => readyP || (readyP = call('init', { py: PY }).catch(e => {
  readyP = null;
  throw new Error('Could not start the converter. ' + e.message);
}));
ready().catch(() => {});

/* ---------- state ---------- */
const AXN = { wght: 'Weight', wdth: 'Width' };
let items = [], nextId = 1;
let built = null, building = false, curIdx = 0, cur = {}, resultURL = null, resultN = 0;
let timer = null, token = 0;
const cache = new Map();

const faceStyle = document.createElement('style');
const resultStyle = document.createElement('style');
document.head.append(faceStyle, resultStyle);

const msg = (t, err) => { $('msg').textContent = t || ''; $('msg').className = err ? 'err' : ''; };
const status = (t, kind) => { $('wmsg').textContent = t || ''; $('wmsg').className = kind || ''; };
const fvs = c => Object.entries(c).map(([k, v]) => `"${k}" ${v}`).join(',');
const num = v => Number.isInteger(v) ? v : +v.toFixed(2);
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
  items.forEach(it => { it.url && URL.revokeObjectURL(it.url); call('forget', { fid: it.id }).catch(() => {}); });
  items = [];
  built = null; building = false; token++;
  clearTimeout(timer);
  cache.clear();
  faceStyle.textContent = '';
  resultStyle.textContent = '';
  $('work').classList.remove('on');
  $('home').style.display = '';
  msg('');
  status('');
};

async function addFiles(files) {
  drop.classList.add('wait');
  const errs = [];
  try {
    msg('Starting converter…');
    await ready();
  } catch (e) {
    msg(e.message, true);
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
      const info = JSON.parse(await call('inspect', { fid: id, bytes: bytes.slice() }));
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
    changed();
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
    return g;
  });
}

const specOf = g => ({
  family: g.family, ital: g.italic, axes: g.axes, default: g.default,
  masters: g.active.map(m => ({ id: m.id, name: m.info.style, wght: m.wght, wdth: m.wdth }))
});

/* Anything changed: refresh the list and (re)blend in the background */
function changed() {
  built = null;
  token++;
  clearTimeout(timer);
  const first = items.find(i => i.on) || items[0];
  if (first) $('sample').style.fontFamily = `"M${first.id}", sans-serif`;
  $('sample').style.fontVariationSettings = '';
  drawList();
  const ok = computeGroups().filter(g => g.active.length && !g.block);
  building = ok.length > 0;
  drawAxes();
  sync();
  if (ok.length) {
    status('Blending…', 'note');
    timer = setTimeout(runBuild, 500);
  } else {
    status('');
  }
}

async function runBuild() {
  const my = token;
  const groups = computeGroups().filter(g => g.active.length && !g.block);
  const results = [], notes = [];
  try {
    for (const g of groups) {
      const spec = specOf(g);
      const key = JSON.stringify(spec);
      let r = cache.get(key);
      if (!r) {
        status(`Blending ${g.family}${g.italic ? ' Italic' : ''}…`, 'note');
        const out = await call('build', { spec: key });
        r = { data: out.data, info: out.info };
        cache.set(key, r);
      }
      if (my !== token) return;
      results.push({
        label: g.family + (g.italic ? ' Italic' : ''),
        family: g.family, italic: g.italic, ext: g.ext, key,
        data: r.data,
        axes: g.axes.map(t => ({ tag: t, name: AXN[t], min: g.range[t][0], def: g.default[t], max: g.range[t][1] })),
        axTags: g.axes
      });
      const i = r.info;
      if (i.frozen?.length) notes.push(`${g.family}${g.italic ? ' Italic' : ''}: ${i.frozen.length} glyph${i.frozen.length > 1 ? 's' : ''} didn’t line up between styles and stay fixed at the default style’s shape.`);
      if (i.dropped) notes.push(`${i.dropped} glyph${i.dropped > 1 ? 's' : ''} missing from some styles were left out.`);
      if (i.layout) notes.push('Features (kerning, ligatures) differ between styles, so only the default style’s were kept.');
    }
  } catch (e) {
    if (my !== token) return;
    building = false;
    built = null;
    drawAxes();
    sync();
    status('Couldn’t blend these styles. ' + explain(e), 'err');
    return;
  }
  if (my !== token) return;
  building = false;
  built = results;
  showPreview(0);
  sync();
  status(notes.join(' '), notes.length ? 'note' : '');
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
  if (!built || !built.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = building ? 'Blending a preview…' : 'Add at least two different weights to preview the variable font.';
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
          changed();
        };
        return n;
      };

      const x = document.createElement('button');
      x.type = 'button'; x.className = 'x'; x.textContent = '×'; x.title = 'Remove';

      cb.onclick = e => e.stopPropagation();
      cb.onchange = () => { it.on = cb.checked; changed(); };
      x.onclick = e => {
        e.stopPropagation();
        if (it.url) URL.revokeObjectURL(it.url);
        call('forget', { fid: it.id }).catch(() => {});
        items = items.filter(i => i !== it);
        if (!items.length) { $('reset').onclick(); return; }
        changed();
      };
      r.onclick = () => {
        $('sample').style.fontFamily = `"M${it.id}", sans-serif`;
        $('sample').style.fontVariationSettings = '';
      };

      r.append(cb, nm, mk('wght', 'Weight', it.info.wght), mk('wdth', 'Width', it.info.wdth), x);
      L.appendChild(r);
    });
  });
}

const sync = () => {
  const hasFmt = $('fNative').checked || $('fW2').checked;
  const n = built ? built.length : 0;
  $('go').textContent = building ? 'Blending…' : (n ? `Export (${n})` : 'Export');
  $('go').disabled = !(n && !building && hasFmt && $('agree').checked);
};

$('agree').onchange = sync;
$('fNative').onchange = sync;
$('fW2').onchange = sync;
$('selAll').onclick = () => { items.forEach(i => i.on = true); changed(); };
$('selNone').onclick = () => { items.forEach(i => i.on = false); changed(); };

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

const readme = groups => `Variable fonts made with Melting Statics.\n\n` + groups.map(g => {
  const src = computeGroups().find(x => x.family === g.family && x.italic === g.italic);
  const ms = src ? src.active : [];
  const i = ms[0]?.info || {};
  return `${g.label}\nMasters: ${ms.map(m => `${m.info.style} (wght ${num(m.wght)}, wdth ${num(m.wdth)})`).join(', ')}\nSource files: ${ms.map(m => m.name).join(', ')}\nCopyright: ${i.copyright || 'not stated'}\nLicense: ${i.license || 'not stated'}\nLink: ${i.licenseUrl || 'not stated'}\n`;
}).join('\n');

$('go').onclick = async () => {
  if (!built || !built.length) return;
  const groups = built;
  const wantNative = $('fNative').checked, wantW2 = $('fW2').checked;
  if (!wantNative && !wantW2) return;

  $('go').disabled = true;
  $('go').textContent = 'Exporting…';
  try {
    const out = [];
    for (const g of groups) {
      const base = g.family.replace(/\W+/g, '') + (g.italic ? '-Italic' : '') + '[' + g.axTags.join(',') + ']';
      if (wantNative) out.push({ name: base + '.' + g.ext, data: g.data });
      if (wantW2) {
        if (!g.w2) g.w2 = await call('woff2', { data: g.data.slice() });
        out.push({ name: base + '.woff2', data: g.w2 });
      }
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
  } catch (e) {
    status('Export failed. ' + explain(e), 'err');
  }
  sync();
};
