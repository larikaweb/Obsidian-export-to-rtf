/*
  Obsidian Plugin: Export to RTF
  - Converts Markdown to RTF with support for:
    • Headings H1–H6, paragraphs, quotes
    • UL/OL lists with proper indentation
    • Tables
    • Callouts (rendered as a 1×1 boxed table)
    • Inline styles: bold/italic/underline/strike/code/mark, color/background
    • Links:
        - http(s)/mailto → native RTF hyperlinks
        - non-standard schemes (e.g., whatsapp://, tg://, obsidian://) → "🔗 [Text](URL)"
    • Images <img> → 1×1 boxed placeholder with file name or full path (setting), dashed border + 🖼 prefix
  - Desktop & mobile friendly:
    • Command palette
    • Editor/file context menus
    • Ribbon icon
  - Settings:
    • Show full image path
*/

const {
  Plugin,
  MarkdownRenderer,
  Notice,
  PluginSettingTab,
  Setting
} = require('obsidian');

const DEFAULT_SETTINGS = {
  showFullImagePath: false,
};

// ---------- RTF utils ----------

function encodeTextToRtf(txt) {
  // Encode per 16-bit units to handle surrogate pairs (emoji, etc.)
  let out = '';
  for (let i = 0; i < (txt?.length || 0); i++) {
    const ch = txt[i];
    const code = txt.charCodeAt(i);
    if (ch === '\\') out += '\\\\';
    else if (ch === '{') out += '\\{';
    else if (ch === '}') out += '\\}';
    else if (code === 10) out += '\\line ';
    else if (code <= 127) out += ch;
    else {
      const n = code > 32767 ? code - 65536 : code; // signed 16-bit
      out += `\\u${n}?`;
    }
  }
  return out;
}

function escapeForFldinst(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function parseColorToRGB(str) {
  if (!str) return null;
  str = str.trim();

  let m = str.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  m = str.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const r = parseInt(m[1][0] + m[1][0], 16);
    const g = parseInt(m[1][1] + m[1][1], 16);
    const b = parseInt(m[1][2] + m[1][2], 16);
    return { r, g, b };
  }
  m = str.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (m) {
    return {
      r: Math.max(0, Math.min(255, +m[1] | 0)),
      g: Math.max(0, Math.min(255, +m[2] | 0)),
      b: Math.max(0, Math.min(255, +m[3] | 0))
    };
  }
  return null;
}

function collectColors(root) {
  // Preload yellow (mark), black (borders), blue (links), light gray (callout/img bg)
  const set = new Map();
  const addFixed = (rgb) => {
    const key = `${rgb.r},${rgb.g},${rgb.b}`;
    if (!set.has(key)) set.set(key, set.size + 1);
  };
  addFixed({ r:255, g:255, b:0 });    // yellow
  addFixed({ r:0,   g:0,   b:0 });    // black
  addFixed({ r:0,   g:0,   b:255 });  // blue
  addFixed({ r:245, g:245, b:245 });  // light gray #F5F5F5 for boxed cells

  const add = (rgb) => {
    if (!rgb) return null;
    const key = `${rgb.r},${rgb.g},${rgb.b}`;
    if (!set.has(key)) set.set(key, set.size + 1);
    return set.get(key);
  };

  (function walk(n) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n;
      const style = (el.getAttribute('style') || '').toLowerCase();
      const mColor = style.match(/(^|;)\s*color\s*:\s*([^;]+)/);
      const mBg    = style.match(/(^|;)\s*background(?:-color)?\s*:\s*([^;]+)/);
      if (mColor) add(parseColorToRGB(mColor[2].trim()));
      if (mBg)    add(parseColorToRGB(mBg[2].trim()));
    }
    n.childNodes.forEach(walk);
  })(root);

  const colors = Array.from(set.keys()).map(k => {
    const [r,g,b] = k.split(',').map(Number);
    return { r, g, b };
  });

  const table = '{\\colortbl;' + colors.map(c => `\\red${c.r}\\green${c.g}\\blue${c.b};`).join('') + '}';
  const indexOf = (rgb) => (!rgb ? null : set.get(`${rgb.r},${rgb.g},${rgb.b}`) ?? null);
  const markIndex = indexOf({ r:255, g:255, b:0 }) || 1;
  const linkBlueIndex = indexOf({ r:0, g:0, b:255 }) || null;
  const calloutBgIndex = indexOf({ r:245, g:245, b:245 }) || null;

  return { table, indexOf, markIndex, linkBlueIndex, calloutBgIndex };
}

// ---------- HTML → RTF ----------

function htmlToRtf(html, settings = DEFAULT_SETTINGS) {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const {
    table: colorTable,
    indexOf: colorIndex,
    markIndex: markColorIndex,
    linkBlueIndex,
    calloutBgIndex
  } = collectColors(dom.body);

  const H_FS = { H1: 48, H2: 40, H3: 36, H4: 32, H5: 28, H6: 24 };
  const defaultFs = 24;

  const trimHeadTail = (s) =>
    (s ?? '')
      .replace(/^[ \t]+/g, '')
      .replace(/^(\\line\s*)+/g, '')
      .replace(/(\\line\s*)+$/g, '');

  const openPara  = (props = '') => `{\\pard${props} `;
  const closePara = () => `\\par}\\pard\\plain\\f0\\fs${defaultFs} `;

  function withInline(el, inner) {
    let prefix = '', suffix = '';
    const tag = el.tagName;
    const style = (el.getAttribute('style') || '').toLowerCase();

    if (/^(B|STRONG)$/.test(tag)) { prefix += '\\b '; suffix = '\\b0 ' + suffix; }
    if (/^(I|EM)$/.test(tag))     { prefix += '\\i '; suffix = '\\i0 ' + suffix; }
    if (tag === 'U')              { prefix += '\\ul '; suffix = '\\ul0 ' + suffix; }
    if (tag === 'S' || tag === 'DEL') { prefix += '\\strike '; suffix = '\\strike0 ' + suffix; }
    if (tag === 'CODE' && el.parentElement?.tagName !== 'PRE') { prefix += '\\f1 '; suffix = '\\f0 ' + suffix; }
    if (tag === 'MARK' && typeof markColorIndex === 'number') {
      prefix += `\\highlight${markColorIndex} `;
      suffix  = '\\highlight0 ' + suffix;
    }

    const mColor = style.match(/(^|;)\s*color\s*:\s*([^;]+)/);
    if (mColor) {
      const idx = colorIndex(parseColorToRGB(mColor[2].trim()));
      if (idx) { prefix += `\\cf${idx} `; suffix = '\\cf0 ' + suffix; }
    }
    const mBg = style.match(/(^|;)\s*background(?:-color)?\s*:\s*([^;]+)/);
    if (mBg) {
      const idx = colorIndex(parseColorToRGB(mBg[2].trim()));
      if (idx) { prefix += `\\highlight${idx} `; suffix = '\\highlight0 ' + suffix; }
    }

    return prefix + inner + suffix;
  }

  // Boxed cell with optional border style (solid/dash/dot) and light-gray bg
  const renderSingleCellBox = (innerRtf, opts = {}) => {
    const inner = trimHeadTail(innerRtf || '');
    const cellRight = 10000;

    const bg = (typeof calloutBgIndex === 'number' && calloutBgIndex > 0)
      ? `\\clshdng0\\clcbpat${calloutBgIndex}`    // solid background, no foreground overlay
      : '';

    const br = opts.borderStyle === 'dash' ? '\\brdrdash'
            : opts.borderStyle === 'dot'  ? '\\brdrdot'
            : '\\brdrs'; // default solid

    return '{\\trowd\\trgaph108\\trleft0 '
      + `\\clbrdrt${br}\\brdrw10`
      + `\\clbrdrl${br}\\brdrw10`
      + `\\clbrdrb${br}\\brdrw10`
      + `\\clbrdrr${br}\\brdrw10`
      + `${bg} `
      + `\\cellx${cellRight} `
      + `{\\pard\\intbl ${inner}\\line \\cell}`
      + '\\row}'
      + `\\pard\\plain\\f0\\fs${defaultFs} `;
  };

  function renderCalloutAsSingleCell(el, walkFn) {
    const titleEl   = el.querySelector('.callout-title');
    const contentEl = el.querySelector('.callout-content');

    const parts = [];
    if (titleEl) {
      let t = Array.from(titleEl.childNodes).map(n => walkFn(n, { inTable: true })).join('');
      t = trimHeadTail(t);
      if (t) parts.push(`\\b ${t}\\b0`);
    }
    if (contentEl) {
      let c = Array.from(contentEl.childNodes).map(n => walkFn(n, { inTable: true })).join('');
      c = trimHeadTail(c);
      if (c) parts.push(c);
    }
    if (!titleEl && !contentEl) {
      let all = Array.from(el.childNodes).map(n => walkFn(n, { inTable: true })).join('');
      all = trimHeadTail(all);
      if (all) parts.push(all);
    }

    const inner = trimHeadTail(parts.filter(Boolean).join(' \\line '));
    // Callout: solid border (default)
    return renderSingleCellBox(inner);
  }

  function renderLiBlockParagraph(el, ctx, baseIndentTwips) {
    const style = (el.getAttribute('style') || '').toLowerCase();
    const mBg = style.match(/(^|;)\s*background(?:-color)?\s*:\s*([^;]+)/);
    let prefix = '', suffix = '';
    if (mBg) {
      const idx = colorIndex(parseColorToRGB(mBg[2].trim()));
      if (idx) { prefix = `\\highlight${idx} `; suffix = '\\highlight0 '; }
    }
    const inner = trimHeadTail(Array.from(el.childNodes).map(n => walk(n, { ...ctx, inList: true })).join(''));
    if (!inner) return '';
    if (ctx.inTable) {
      return `{\\pard\\intbl\\li${baseIndentTwips + 720}\\fi0 ${prefix}${inner}${suffix}\\line }`;
    }
    return openPara(`\\li${baseIndentTwips + 720}\\fi0\\sa60`) + prefix + inner + suffix + closePara();
  }

  function splitLiPreservingOrder(li, ctx, level, baseIndentTwips) {
    let headText = '';
    let headTaken = false;
    const tailPieces = [];

    li.childNodes.forEach(n => {
      if (n.nodeType === Node.ELEMENT_NODE && (n.tagName === 'UL' || n.tagName === 'OL')) {
        const r = renderList(n, { ...ctx, listLevel: level + 1 });
        if (r) tailPieces.push({ type: 'list', rtf: r });
        return;
      }
      if (n.nodeType === Node.ELEMENT_NODE && (n.tagName === 'P' || n.tagName === 'DIV')) {
        if (!headTaken) {
          headText += trimHeadTail(Array.from(n.childNodes).map(c => walk(c, { ...ctx, inList: true })).join(''));
          headTaken = true;
        } else {
          const r = renderLiBlockParagraph(n, ctx, baseIndentTwips);
          if (r) tailPieces.push({ type: 'block', rtf: r });
        }
        return;
      }
      if (n.nodeType === Node.ELEMENT_NODE && (n.tagName === 'PRE' || n.tagName === 'BLOCKQUOTE')) {
        const r = renderLiBlockParagraph(n, ctx, baseIndentTwips);
        if (r) tailPieces.push({ type: 'block', rtf: r });
        return;
      }
      headText += walk(n, { ...ctx, inList: true });
    });

    headText = trimHeadTail(headText);
    const tailRtf = tailPieces.map(p => p.rtf).join('');
    return { headText, tailRtf };
  }

  function renderList(el, ctx) {
    let out = '';
    const level  = ctx.listLevel || 1;
    const indent = 720 * level;

    if (el.tagName === 'UL') {
      for (const li of el.children) {
        if (li.tagName !== 'LI') continue;
        const { headText, tailRtf } = splitLiPreservingOrder(li, ctx, level, indent);
        if (ctx.inTable) {
          out += `\\li${indent} \\u8226? ${headText} \\li0 \\line `;
          out += tailRtf;
        } else {
          out += openPara(`\\li${indent}\\fi0\\sa60`) + '\\u8226? ' + headText + closePara();
          out += tailRtf;
        }
      }
      return out;
    }

    if (el.tagName === 'OL') {
      let n = 1;
      for (const li of el.children) {
        if (li.tagName !== 'LI') continue;
        const { headText, tailRtf } = splitLiPreservingOrder(li, ctx, level, indent);
        const useBullet = level > 1;
        if (ctx.inTable) {
          if (useBullet) out += `\\li${indent} \\u8226? ${headText} \\li0 \\line `;
          else           out += `\\li${indent} ${encodeTextToRtf(String(n++) + '. ')}${headText} \\li0 \\line `;
          out += tailRtf;
        } else {
          if (useBullet) out += openPara(`\\li${indent}\\fi0\\sa60`) + '\\u8226? ' + headText + closePara();
          else           out += openPara(`\\li${indent}\\fi0\\sa60`) + encodeTextToRtf(String(n++) + '. ') + headText + closePara();
          out += tailRtf;
        }
      }
      return out;
    }

    return out;
  }

  function walk(node, ctx = { inTable: false, inList: false, listLevel: 0 }) {
    if (node.nodeType === Node.TEXT_NODE) {
      const s = node.nodeValue ?? '';
      if (ctx.inTable && /^\s+$/.test(s)) return '';
      return encodeTextToRtf(s);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = node;

    if (el.tagName === 'BR')     return '\\line ';
    if (el.tagName === 'TABLE')  return renderTable(el);

    if (/^H[1-6]$/.test(el.tagName)) {
      const sz = H_FS[el.tagName] || 32;
      if (ctx.inTable) {
        let inner = Array.from(el.childNodes).map(n => walk(n, ctx)).join('');
        inner = trimHeadTail(inner);
        return `\\b\\fs${sz} ${inner}\\b0\\fs${defaultFs} \\line `;
      } else {
        let r = openPara(`\\sb240\\sa120\\keepn\\b\\fs${sz}`);
        r += Array.from(el.childNodes).map(n => walk(n, ctx)).join('');
        r += closePara();
        return r;
      }
    }

    if (el.tagName === 'BLOCKQUOTE') {
      if (ctx.inTable) {
        let inner = Array.from(el.childNodes).map(n => walk(n, ctx)).join('');
        inner = trimHeadTail(inner);
        return '\\i ' + inner + '\\i0 \\line ';
      } else {
        let r = openPara('\\li720\\sb120\\sa120\\i');
        r += Array.from(el.childNodes).map(n => walk(n, ctx)).join('');
        r += closePara();
        return r;
      }
    }

    if (el.matches && el.matches('div.callout')) {
      return renderCalloutAsSingleCell(el, walk);
    }

    if (el.tagName === 'P' || el.tagName === 'DIV') {
      const style = (el.getAttribute('style') || '').toLowerCase();
      const mBg = style.match(/(^|;)\s*background(?:-color)?\s*:\s*([^;]+)/);

      if (ctx.inList) {
        let prefix = '', suffix = '';
        if (mBg) {
          const idx = colorIndex(parseColorToRGB(mBg[2].trim()));
          if (idx) { prefix = `\\highlight${idx} `; suffix = '\\highlight0 '; }
        }
        let inner = trimHeadTail(Array.from(el.childNodes).map(n => walk(n, { ...ctx, inList: true })).join(''));
        return prefix + inner + suffix;
      }

      if (ctx.inTable) {
        let prefix = '', suffix = '';
        if (mBg) {
          const idx = colorIndex(parseColorToRGB(mBg[2].trim()));
          if (idx) { prefix = `\\highlight${idx} `; suffix = '\\highlight0 '; }
        }
        let inner = trimHeadTail(Array.from(el.childNodes).map(n => walk(n, ctx)).join(''));
        return prefix + inner + suffix + '\\line ';
      } else {
        let props = '\\sa120';
        let prefix = '', suffix = '';
        if (mBg) {
          const idx = colorIndex(parseColorToRGB(mBg[2].trim()));
          if (idx) { prefix = `\\highlight${idx} `; suffix = '\\highlight0 '; }
        }
        let inner = Array.from(el.childNodes).map(n => walk(n, ctx)).join('');
        return openPara(props) + inner + closePara();
      }
    }

    if (el.tagName === 'UL' || el.tagName === 'OL') {
      return renderList(el, { ...ctx, listLevel: (ctx.listLevel || 0) + 1 });
    }

    if (el.tagName === 'PRE') {
      let inner = trimHeadTail(Array.from(el.childNodes).map(n => walk(n, ctx)).join(''));
      if (ctx.inTable) return '\\f1 ' + inner + '\\f0 \\line ';
      return openPara('\\li720\\sa120\\f1') + inner + closePara();
    }

    if (el.tagName === 'IMG') {
      const srcRaw = (el.getAttribute('src') || '').trim();
      const src = srcRaw || 'image';
      const nameCandidate = src.split('/').pop() || src;
      const name = nameCandidate.split('?')[0].split('#')[0] || 'image';
      const textToShow = settings.showFullImagePath ? src : name;
      const inner = encodeTextToRtf('🖼 ' + textToShow);
      // Image placeholder: dashed border to differentiate from callouts
      return renderSingleCellBox(inner, { borderStyle: 'dash' });
    }

    if (el.tagName === 'A') {
      const href = (el.getAttribute('href') || el.getAttribute('data-href') || '').trim();
      const displayText = el.textContent && el.textContent.trim()
        ? el.textContent.trim()
        : href;
      const disp = encodeTextToRtf(displayText || '');

      if (!href) return disp;

      const isHttp = /^https?:\/\//i.test(href);
      const isMail = /^mailto:/i.test(href);

      if (isHttp || isMail) {
        const urlEsc = escapeForFldinst(href);
        const blue = (typeof linkBlueIndex === 'number' && linkBlueIndex > 0) ? `\\cf${linkBlueIndex} ` : '';
        return `{\\field{\\*\\fldinst HYPERLINK "${urlEsc}"}{\\fldrslt ${blue}\\ul ${disp}\\ul0\\cf0}}`;
      }

      const show = displayText || href;
      const icon = encodeTextToRtf('🔗 ');
      const boxedWithUrl = '[' + show + '](' + href + ')';
      return icon + encodeTextToRtf(boxedWithUrl);
    }

    if (['SPAN','B','STRONG','I','EM','U','S','DEL','CODE','MARK'].includes(el.tagName)) {
      const inner = Array.from(el.childNodes).map(n => walk(n, ctx)).join('');
      return withInline(el, inner);
    }

    return Array.from(el.childNodes).map(n => walk(n, ctx)).join('');
  }

  function renderTable(tbl) {
    const rows = Array.from(tbl.querySelectorAll('tr'));
    if (!rows.length) return '';
    const cols = Math.max(...rows.map(r => r.children.length));
    const cellWidth = 1800;

    let out = '';
    for (const tr of rows) {
      let curX = 0;
      out += '{\\trowd\\trleft0\\trgaph0'
           + '\\trpaddl0\\trpaddr0\\trpaddt0\\trpaddb0'
           + '\\trpadfl3\\trpadfr3\\trpadft3\\trpadfb3 ';
      for (let c = 0; c < cols; c++) {
        curX += cellWidth;
        out += '\\clbrdrt\\brdrs\\brdrw10'
            +  '\\clbrdrl\\brdrs\\brdrw10'
            +  '\\clbrdrb\\brdrs\\brdrw10'
            +  '\\clbrdrr\\brdrs\\brdrw10'
            +  `\\cellx${curX} `;
      }

      const cells = Array.from(tr.children);
      for (let c = 0; c < cols; c++) {
        const td = cells[c];
        let content = td
          ? Array.from(td.childNodes).map(n => walk(n, { inTable: true, listLevel: 0 })).join('')
          : '';
        content = content
          .replace(/^(?:\\(?:line|par)\s*)+/g, '')
          .replace(/^[\uFEFF\u200B\u00A0\s]+/g, '');

        out += `{\\pard\\intbl\\sb0\\sa0\\sl0\\slmult1\\f0\\fs${defaultFs} ${content}\\cell}`;
      }

      out += '\\row}';
      out += `\\pard\\plain\\f0\\fs${defaultFs} `;
    }
    return out;
  }

  let rtf = '{\\rtf1\\ansi\\deff0\\uc1\\viewkind4\n'
          + '{\\fonttbl{\\f0\\fnil Arial;}{\\f1\\fmodern Courier New;}}\n'
          + colorTable + '\n'
          + `\\f0\\fs${defaultFs} `;

  rtf += [...dom.body.childNodes].map(n => walk(n)).join('');
  rtf += '}';

  return rtf;
}

// ---------- Markdown → HTML renderer ----------

class HtmlRenderer {
  constructor(app, component) { this.app = app; this.component = component; }
  async render(markdown) {
    const container = document.createElement('div');
    await MarkdownRenderer.render(this.app, markdown, container, ".", this.component);
    container.querySelectorAll(".copy-code-button").forEach(btn => btn.remove());
    await new Promise(res => setTimeout(res, 20)); // small tick to settle layout
    return container.innerHTML;
  }
}

// ---------- Export active note to RTF file ----------

async function exportActiveToRtf(app, plugin) {
  const file = app.workspace.getActiveFile();
  if (!file) { new Notice("No active note"); return; }
  const md = await app.vault.read(file);
  const renderer = new HtmlRenderer(app, plugin);
  const html = await renderer.render(md);
  const rtf = htmlToRtf(html, plugin.settings);
  const blob = new Blob([rtf], { type: "application/rtf" });
  const filename = (file.basename || "markdown") + ".rtf";
  downloadFile(blob, filename);
  new Notice("RTF file downloaded!");
}

function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename || "download"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 150);
}

// ---------- Settings tab ----------

class ExportToRtfSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Export to RTF – Settings' });

    new Setting(containerEl)
      .setName('Show full image path')
      .setDesc('If off, only the image file name is shown in the placeholder.')
      .addToggle(t => t
        .setValue(this.plugin.settings.showFullImagePath)
        .onChange(async (v) => {
          this.plugin.settings.showFullImagePath = v;
          await this.plugin.saveSettings();
        }));
  }
}

// ---------- Plugin ----------

module.exports = class ExportToRtfPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    // Command (palette; assign hotkey in Settings → Hotkeys)
    this.addCommand({
      id: "download-as-rtf",
      name: "Download as RTF file",
      editorCallback: async (editor) => {
        try {
          const md = editor.getValue();
          const renderer = new HtmlRenderer(this.app, this);
          const html = await renderer.render(md);
          const rtfContent = htmlToRtf(html, this.settings);
          const blob = new Blob([rtfContent], { type: "application/rtf" });
          const file = this.app.workspace.getActiveFile();
          const filename = ((file && file.basename) || "markdown") + ".rtf";
          downloadFile(blob, filename);
          new Notice("RTF file downloaded!");
        } catch (e) {
          console.error(e);
          new Notice("RTF export failed. See console.");
        }
      }
    });

    // Editor context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu) => {
        menu.addItem(item => {
          item.setTitle("Export to RTF")
            .onClick(async () => {
              try { await exportActiveToRtf(this.app, this); }
              catch (e) { console.error(e); new Notice("RTF export failed. See console."); }
            });
        });
      })
    );

    // File context menu (right-click on .md)
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file?.extension !== "md") return;
        menu.addItem(item => {
          item.setTitle("Export to RTF")
            .onClick(async () => {
              try {
                const md = await this.app.vault.read(file);
                const renderer = new HtmlRenderer(this.app, this);
                const html = await renderer.render(md);
                const rtf = htmlToRtf(html, this.settings);
                const blob = new Blob([rtf], { type: "application/rtf" });
                const filename = (file.basename || "markdown") + ".rtf";
                downloadFile(blob, filename);
                new Notice("RTF file downloaded!");
              } catch (e) {
                console.error(e);
                new Notice("RTF export failed. See console.");
              }
            });
        });
      })
    );

    // Ribbon icon (quick export)
    this.addRibbonIcon("file-type-doc", "Export to RTF", async () => {
      try { await exportActiveToRtf(this.app, this); }
      catch (e) { console.error(e); new Notice("RTF export failed. See console."); }
    });

    this.addSettingTab(new ExportToRtfSettingTab(this.app, this));
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
