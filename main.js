const { Plugin, PluginSettingTab, Setting, TFolder, Notice, apiVersion } = require('obsidian');

const DEFAULT_SETTINGS = {
  uiLanguage: 'auto',
  collapseOnEditorClick: true,
  collapseOnActiveLeafChange: true,
  collapseOnFileOpen: true,
  keepMode: 'path',
  revealMode: 'anchor',
  revealCenterRatio: 40,
  activeFileHighlight: 'accent',
  autoCollapseEnabled: true,
  inactivityMinutes: 5,
  exclusiveAccordionEnabled: true,
  debugLogging: false,
  debugBypass: false,
};

const KEEP_MODES = ['path', 'path-siblings', 'path-subtree'];
// Legacy strategy list, kept only for migrating the old two-key settings.
const REVEAL_STRATEGIES = ['anchor', 'center', 'nearest'];
const REVEAL_MODES = ['off', 'anchor', 'center', 'nearest'];
const HIGHLIGHT_MODES = ['accent', 'bar', 'off'];
// Preferred vertical band for the active row, as a fraction of the explorer height.
const REVEAL_BAND_TOP = 0.1;
const REVEAL_BAND_BOTTOM = 0.78;
const REVEAL_CORRECTION_MS = 250;
const UI_LANGUAGES = ['auto', 'zh', 'en'];
const ICON_SELECTORS = '.collapse-icon, .tree-item-collapse, [data-action="toggle-folder"]';
const EXPLORER_SELECTORS = [
  '.nav-files-container.node-insert-event',
  '.file-explorer-view',
  '.workspace-leaf-content[data-type="file-explorer"]',
  '.workspace-tab-container .nav-files-container',
];
const SAMPLE_DURATION_MS = 700;
const MAX_DEBUG_ENTRIES = 50000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let languageOverride = null;

function setLanguageOverride(lang) {
  languageOverride = lang === 'zh' || lang === 'en' ? lang : null;
}

function getLanguage() {
  if (languageOverride) return languageOverride;
  try {
    const raw = window.localStorage.getItem('language') || '';
    return raw.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch (error) {
    return 'zh';
  }
}

const t = (zh, en) => (getLanguage() === 'zh' ? zh : en);

// Old settings split scrolling (boolean) from landing position (strategy).
function legacyRevealMode(loaded) {
  if (loaded && loaded.revealActiveFile === false) return 'off';
  const strategy = loaded && loaded.revealStrategy;
  return REVEAL_STRATEGIES.includes(strategy) ? strategy : 'anchor';
}

function parentFolder(path) {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function ancestorFolders(path) {
  const segments = path.split('/');
  segments.pop();
  const result = [];
  let current = '';
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    result.push(current);
  }
  return result;
}

// data-path lives on .nav-folder-title in current Obsidian builds, not on .nav-folder.
function folderPathOf(el) {
  const own = el.getAttribute('data-path');
  if (own) return own;
  const title = el.querySelector(':scope > .nav-folder-title[data-path]');
  return title ? title.getAttribute('data-path') : null;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTimestamp(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

class DebugLog {
  constructor(plugin) {
    this.plugin = plugin;
    this.entries = [];
    this.pendingFolders = new Map();
    this.pendingFlush = null;
  }

  get enabled() {
    return !!this.plugin.settings.debugLogging;
  }

  clear() {
    this.entries = [];
    this.pendingFolders.clear();
  }

  record(event, data) {
    if (!this.enabled) return;
    const now = performance.now();
    this.entries.push({ t: now, event, data: data || {} });
    if (this.entries.length > MAX_DEBUG_ENTRIES) this.entries.splice(0, 10000);
  }

  recordMutations(mutations) {
    if (!this.enabled) return;
    let changed = false;
    for (const mutation of mutations) {
      if (mutation.type !== 'attributes' || mutation.attributeName !== 'class') continue;
      const target = mutation.target;
      if (!(target instanceof Element)) continue;
      if (!target.classList.contains('nav-folder')) continue;
      const path = folderPathOf(target);
      if (!path) continue;
      this.pendingFolders.set(path, target.classList.contains('is-collapsed') ? 'C' : 'E');
      changed = true;
    }
    if (!changed || this.pendingFlush) return;

    this.pendingFlush = window.requestAnimationFrame(() => {
      this.pendingFlush = null;
      const items = Array.from(this.pendingFolders.entries());
      this.pendingFolders.clear();
      if (!items.length) return;
      this.record('folders', {
        count: items.length,
        sample: items.slice(0, 25).map(([path, state]) => `${path}=${state}`),
        truncated: items.length > 25,
      });
    });
  }

  format(manifest) {
    const lines = [];
    lines.push('# Folder Focus Collapse 切换调试日志');
    lines.push(`导出时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
    lines.push(`插件版本: ${manifest.version}`);
    lines.push(`apiVersion: ${apiVersion}`);
    lines.push(`设置: ${JSON.stringify(this.plugin.settings)}`);
    lines.push(`条目数: ${this.entries.length}`);
    lines.push('');
    const base = this.entries.length ? this.entries[0].t : performance.now();
    for (const entry of this.entries) {
      lines.push(`+${(entry.t - base).toFixed(1)}ms [${entry.event}] ${this.formatData(entry.data)}`);
    }
    return lines.join('\n');
  }

  formatData(data) {
    return Object.entries(data || {})
      .map(([key, value]) => {
        if (value === null || value === undefined) return `${key}=null`;
        if (typeof value === 'object') return `${key}=${JSON.stringify(value)}`;
        return `${key}=${value}`;
      })
      .join(' ');
  }
}

class FolderFocusCollapsePlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.applyLanguage();
    this.addSettingTab(new FolderFocusCollapseSettingTab(this.app, this));

    this.applyQueued = false;
    this.pendingFile = null;
    this.suppressAccordionUntil = 0;
    this.observer = null;
    this.clickHandler = null;
    this.inactivityTimer = null;
    this.inactivityResetHandler = null;
    this.frameHandle = null;
    this.lastActiveFilePath = null;
    this.syncChecksLeft = 0;
    this.revealGuard = null;
    this.debug = new DebugLog(this);
    this.applyHighlightClass();

    // Obsidian has no public 'editor-click' event; catch the click on the editor DOM.
    this.registerDomEvent(
      document,
      'mousedown',
      (event) => {
        if (event.button !== 0) return;
        const target = event.target instanceof Element ? event.target : null;
        if (!target || !target.closest('.cm-editor')) return;
        const file = this.fileForEditorTarget(target);
        this.debug.record('event.editor-mousedown', { file: file ? file.path : null });
        if (this.settings.debugBypass) return;
        if (!this.settings.collapseOnEditorClick) return;
        if (file) this.scheduleApply(file);
      },
      { capture: true }
    );

    this.registerDomEvent(
      document,
      'scroll',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (!target.classList.contains('nav-files-container')) return;
        if (this.settings.debugLogging) {
          this.debug.record('scroll', { top: Math.round(target.scrollTop) });
        }
        this.handleRevealScroll(target);
      },
      { capture: true }
    );

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        const file = this.app.workspace.getActiveFile();
        this.debug.record('event.active-leaf-change', {
          file: file ? file.path : null,
          previous: this.lastActiveFilePath,
          leaf: leaf && leaf.view && leaf.view.getViewType ? leaf.view.getViewType() : null,
        });
        this.lastActiveFilePath = file ? file.path : null;
        if (this.settings.debugLogging && file) this.startFrameSampling(file);
        if (this.settings.debugBypass) return;
        if (!this.settings.collapseOnActiveLeafChange) return;
        if (file) this.scheduleApply(file);
      })
    );

    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        this.debug.record('event.file-open', { file: file ? file.path : null });
        if (this.settings.debugBypass) return;
        if (!this.settings.collapseOnFileOpen) return;
        if (file) this.scheduleApply(file);
      })
    );

    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.debug.record('event.layout-change', {});
        this.setupExplorer();
      })
    );
    if (this.app.workspace.layoutReady) {
      this.setupExplorer();
    } else {
      this.registerEvent(this.app.workspace.on('layout-ready', () => this.setupExplorer()));
    }

    this.addCommand({
      id: 'export-switch-debug-log',
      name: t('导出文件树切换调试日志', 'Export file-explorer switch debug log'),
      callback: () => void this.exportDebugLog(),
    });
    this.addCommand({
      id: 'clear-switch-debug-log',
      name: t('清空文件树切换调试日志', 'Clear file-explorer switch debug log'),
      callback: () => {
        this.debug.clear();
        new Notice(t('调试日志已清空', 'Debug log cleared'));
      },
    });

    if (this.settings.autoCollapseEnabled) this.startInactivityTimer();
  }

  onunload() {
    this.applyQueued = false;
    this.pendingFile = null;
    this.revealGuard = null;
    if (this.frameHandle) window.cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
    document.body.classList.remove('ffc-highlight-accent', 'ffc-highlight-bar');
    setLanguageOverride(null);
    this.detachExplorerListeners();
    this.stopInactivityTimer();
  }

  applyHighlightClass() {
    const mode = HIGHLIGHT_MODES.includes(this.settings.activeFileHighlight)
      ? this.settings.activeFileHighlight
      : 'accent';
    document.body.classList.toggle('ffc-highlight-accent', mode === 'accent');
    document.body.classList.toggle('ffc-highlight-bar', mode === 'bar');
  }

  async loadSettings() {
    const loaded = (await this.loadData()) || {};
    const hasLegacyKeys =
      Object.prototype.hasOwnProperty.call(loaded, 'revealActiveFile') ||
      Object.prototype.hasOwnProperty.call(loaded, 'revealStrategy');
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    if (!KEEP_MODES.includes(this.settings.keepMode)) {
      this.settings.keepMode = DEFAULT_SETTINGS.keepMode;
    }
    if (!REVEAL_MODES.includes(loaded.revealMode)) {
      this.settings.revealMode = hasLegacyKeys ? legacyRevealMode(loaded) : DEFAULT_SETTINGS.revealMode;
    }
    delete this.settings.revealActiveFile;
    delete this.settings.revealStrategy;
    if (!HIGHLIGHT_MODES.includes(this.settings.activeFileHighlight)) {
      this.settings.activeFileHighlight = DEFAULT_SETTINGS.activeFileHighlight;
    }
    const ratio = Number(this.settings.revealCenterRatio);
    this.settings.revealCenterRatio = Number.isFinite(ratio)
      ? Math.min(55, Math.max(30, ratio))
      : DEFAULT_SETTINGS.revealCenterRatio;
    if (!UI_LANGUAGES.includes(this.settings.uiLanguage)) {
      this.settings.uiLanguage = DEFAULT_SETTINGS.uiLanguage;
    }
    // Persist the migration so later loads no longer see the legacy keys.
    if (hasLegacyKeys) await this.saveData(this.settings);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  applyLanguage() {
    const value = this.settings.uiLanguage;
    setLanguageOverride(value === 'zh' || value === 'en' ? value : null);
  }

  effectiveLanguage() {
    return getLanguage();
  }

  fileForEditorTarget(target) {
    const leaf = this.app.workspace.getLeavesOfType('markdown').find((candidate) => {
      const view = candidate.view;
      return view && view.containerEl && view.containerEl.contains(target);
    });
    if (leaf && leaf.view && leaf.view.file) return leaf.view.file;
    return this.app.workspace.getActiveFile();
  }

  // Runs before the next paint so the explorer never shows the pre-collapse
  // tree (native reveal expands and scrolls ~100ms later on its own timer).
  scheduleApply(file) {
    this.debug.record('plugin.schedule', { file: file.path, mode: 'microtask' });
    this.pendingFile = file;
    if (this.applyQueued) return;
    this.applyQueued = true;
    queueMicrotask(() => {
      this.applyQueued = false;
      const target = this.pendingFile;
      this.pendingFile = null;
      if (target) this.applyToFile(target);
    });
  }

  applyToFile(file) {
    if (!file || !file.path) return;
    if (this.settings.debugBypass) return;
    const leaves = this.app.workspace.getLeavesOfType('file-explorer');
    if (!leaves.length) {
      this.debug.record('apply.skip', { reason: 'no file explorer' });
      return;
    }

    const startedAt = performance.now();
    const ancestors = ancestorFolders(file.path);
    const ancestorSet = new Set(ancestors);
    this.syncChecksLeft = 3;
    // Our own expand/collapse must not be read as a manual accordion gesture.
    this.suppressAccordionUntil = performance.now() + 300;
    this.debug.record('apply.start', {
      file: file.path,
      leaves: leaves.length,
      ancestors,
      suppressMs: 300,
    });

    const wantsReveal = this.settings.revealMode !== 'off';
    for (const leaf of leaves) {
      const view = leaf.view;
      if (!view || !view.containerEl) continue;
      // Anchor position must be captured before the tree changes height.
      const revealContext = wantsReveal ? this.captureRevealContext(view, file) : null;
      try {
        const items = view.fileItems;
        this.debug.record('apply.view', {
          hasApi: !!(items && typeof items === 'object'),
          itemCount: items && typeof items === 'object' ? Object.keys(items).length : null,
        });
        if (items && typeof items === 'object') {
          this.applyWithApi(view, items, file, ancestors, ancestorSet);
        } else {
          this.applyWithDom(view, file, ancestors, ancestorSet);
        }
        if (wantsReveal) this.revealFile(view, file, revealContext);
      } catch (error) {
        this.debug.record('apply.error', { message: String(error) });
        console.error('[folder-focus-collapse] failed to update file explorer', error);
      }
    }

    this.debug.record('apply.done', { ms: Number((performance.now() - startedAt).toFixed(1)) });
  }

  applyWithApi(view, items, file, ancestors, ancestorSet) {
    const expanded = [];
    for (const path of ancestors) {
      const item = items[path];
      if (item && item.collapsed) {
        this.setItemCollapsed(view, path, item, false);
        expanded.push(path);
      }
    }
    this.debug.record('expand.ancestors', { count: expanded.length, paths: expanded });

    const startedAt = performance.now();
    const sample = [];
    let collapseCount = 0;
    for (const [path, item] of Object.entries(items)) {
      if (ancestorSet.has(path)) continue;
      if (!this.shouldCollapse(path, file)) continue;
      if (item.collapsed) continue;
      this.setItemCollapsed(view, path, item, true);
      collapseCount += 1;
      if (sample.length < 20) sample.push(path);
    }
    this.debug.record('collapse.done', {
      count: collapseCount,
      ms: Number((performance.now() - startedAt).toFixed(1)),
      sample,
      truncated: collapseCount > sample.length,
    });
  }

  applyWithDom(view, file, ancestors, ancestorSet) {
    const expanded = [];
    for (const path of ancestors) {
      const el = this.findFolderEl(view, path);
      if (el && el.classList.contains('is-collapsed')) {
        this.clickFolderIcon(el);
        expanded.push(path);
      }
    }
    this.debug.record('expand.ancestors', { count: expanded.length, paths: expanded, mode: 'dom' });

    const startedAt = performance.now();
    const sample = [];
    let collapseCount = 0;
    for (const el of view.containerEl.querySelectorAll('.nav-folder, .tree-item-folder')) {
      const path = folderPathOf(el);
      if (!path || ancestorSet.has(path)) continue;
      if (!this.shouldCollapse(path, file)) continue;
      if (el.classList.contains('is-collapsed')) continue;
      this.clickFolderIcon(el);
      collapseCount += 1;
      if (sample.length < 20) sample.push(path);
    }
    this.debug.record('collapse.done', {
      count: collapseCount,
      ms: Number((performance.now() - startedAt).toFixed(1)),
      sample,
      truncated: collapseCount > sample.length,
      mode: 'dom',
    });
  }

  setItemCollapsed(view, path, item, collapsed) {
    if (typeof item.setCollapsed === 'function') {
      item.setCollapsed(collapsed);
      if (collapsed) this.hideFolderNow(view, path);
      this.checkSync(view, path, item, collapsed);
      return;
    }
    const el = this.findFolderEl(view, path);
    if (!el) return;
    if (el.classList.contains('is-collapsed') !== collapsed) this.clickFolderIcon(el);
  }

  // The explorer mirrors collapsed state to the DOM on a later render pass.
  // Hiding the subtree here keeps the pre-collapse tree out of the paint.
  hideFolderNow(view, path) {
    const el = this.findFolderEl(view, path);
    if (!el || el.classList.contains('is-collapsed')) return;
    el.classList.add('is-collapsed');
  }

  checkSync(view, path, item, collapsed) {
    if (!this.settings.debugLogging || this.syncChecksLeft <= 0) return;
    this.syncChecksLeft -= 1;
    const el = this.findFolderEl(view, path);
    this.debug.record('collapse.sync', {
      path,
      want: collapsed ? 'C' : 'E',
      actual: el ? (el.classList.contains('is-collapsed') ? 'C' : 'E') : 'missing',
      hasApi: typeof item.setCollapsed === 'function',
    });
  }

  shouldCollapse(path, file) {
    if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder)) return false;
    return !this.isKeptByMode(path, file);
  }

  isKeptByMode(path, file) {
    const parent = parentFolder(file.path);
    const mode = this.settings.keepMode;

    if (mode === 'path-subtree') {
      if (parent === '') return true;
      return path === parent || path.startsWith(`${parent}/`);
    }
    if (mode === 'path-siblings') {
      return parentFolder(path) === parent;
    }
    return false;
  }

  // Anchor position must be captured before the tree changes height, otherwise
  // the browser's own scroll anchoring hides how far the top folder moved.
  captureRevealContext(view, file) {
    if (this.settings.revealMode === 'nearest') return null;
    const container = this.getViewNavContainer(view);
    if (!container) return null;
    const anchorEl = this.findAnchorEl(view, file.path);
    if (!anchorEl) return { container, anchorEl: null, anchorScreenY: null };
    const containerRect = container.getBoundingClientRect();
    const anchorScreenY = anchorEl.getBoundingClientRect().top - containerRect.top;
    const visible = anchorScreenY >= -1 && anchorScreenY <= container.clientHeight - 20;
    return { container, anchorEl, anchorScreenY: visible ? anchorScreenY : null };
  }

  getViewNavContainer(view) {
    const root = view && view.containerEl;
    if (root) {
      if (root.classList && root.classList.contains('nav-files-container')) return root;
      const nested = root.querySelector('.nav-files-container');
      if (nested) return nested;
    }
    return this.getNavContainer();
  }

  findAnchorEl(view, path) {
    const index = path.indexOf('/');
    if (index < 0) return null;
    return this.findFolderEl(view, path.slice(0, index));
  }

  revealFile(view, file, context) {
    const container = (context && context.container) || this.getViewNavContainer(view);
    if (!container) {
      this.debug.record('reveal.skip', { file: file.path, reason: 'no container' });
      return;
    }
    const item = view.fileItems && view.fileItems[file.path];
    const findEl = () =>
      (item && item.selfEl) ||
      this.findFileEl(view, file.path) ||
      this.findFileElIn(container, file.path);
    this.scheduleReveal(view, file, container, findEl, context, 0);
  }

  // Runs in rAF: expanded folders mount their rows one frame after setCollapsed.
  scheduleReveal(view, file, container, findEl, context, attempt) {
    window.requestAnimationFrame(() => {
      if (!container.isConnected) return;
      const el = findEl();
      if (!el) {
        if (attempt < 2) {
          this.debug.record('reveal.deferred', { file: file.path, attempt: attempt + 1 });
          this.scheduleReveal(view, file, container, findEl, context, attempt + 1);
          return;
        }
        this.debug.record('reveal.skip', { file: file.path, reason: 'row not mounted' });
        return;
      }
      this.applyReveal(view, file, container, el, context);
    });
  }

  applyReveal(view, file, container, el, context) {
    if (!container.isConnected || !el.isConnected) {
      this.debug.record('reveal.skip', { file: file.path, reason: 'detached' });
      return;
    }
    const mode = REVEAL_MODES.includes(this.settings.revealMode)
      ? this.settings.revealMode
      : 'anchor';
    if (mode === 'off') return;
    const before = Math.round(container.scrollTop);

    if (mode === 'nearest') {
      el.scrollIntoView({ block: 'nearest' });
      this.debug.record('reveal', {
        before,
        after: Math.round(container.scrollTop),
        mode,
      });
      return;
    }

    const height = container.clientHeight;
    if (height <= 0 || container.scrollHeight <= height + 1) {
      this.debug.record('reveal.noop', { file: file.path, reason: 'not scrollable' });
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const fileRect = el.getBoundingClientRect();
    const fileTop = fileRect.top - containerRect.top + container.scrollTop;
    const fileBottom = fileRect.bottom - containerRect.top + container.scrollTop;
    const anchorEl =
      context && context.anchorEl && context.anchorEl.isConnected
        ? context.anchorEl
        : this.findAnchorEl(view, file.path);
    const anchorTop = anchorEl
      ? anchorEl.getBoundingClientRect().top - containerRect.top + container.scrollTop
      : null;
    const anchorScreenY = context ? context.anchorScreenY : null;

    const plan = this.computeRevealTarget({
      mode,
      ratio: Math.min(55, Math.max(30, Number(this.settings.revealCenterRatio) || 40)) / 100,
      height,
      currentTop: container.scrollTop,
      maxScroll: Math.max(0, container.scrollHeight - height),
      fileTop,
      fileBottom,
      anchorTop,
      anchorScreenY,
    });

    this.debug.record('reveal.plan', {
      file: file.path,
      mode,
      planMode: plan.mode,
      anchorScreenY: anchorScreenY == null ? null : Math.round(anchorScreenY),
      target: Math.round(plan.target),
    });

    const moved = Math.abs(plan.target - container.scrollTop) >= 1;
    if (moved) this.setContainerScroll(container, plan.target);
    this.armRevealGuard(container, el, plan.target);
    this.debug.record('reveal.apply', {
      before,
      after: Math.round(container.scrollTop),
      mode: plan.mode,
      moved,
    });
  }

  computeRevealTarget(geo) {
    const bandTop = geo.height * REVEAL_BAND_TOP;
    const bandBottom = geo.height * REVEAL_BAND_BOTTOM;
    const clamp = (value) => Math.min(Math.max(value, 0), geo.maxScroll);
    const centered = clamp(geo.fileTop - geo.ratio * geo.height);
    const screenTop = geo.fileTop - geo.currentTop;
    const screenBottom = geo.fileBottom - geo.currentTop;

    if (geo.mode === 'center') return { target: centered, mode: 'center' };

    // Without a visible top-level anchor there is nothing to hold in place.
    if (geo.anchorTop == null || geo.anchorScreenY == null) {
      const comfortable = screenTop >= 0 && screenBottom <= bandBottom;
      return comfortable
        ? { target: geo.currentTop, mode: 'hold' }
        : { target: centered, mode: 'center' };
    }

    const anchorTarget = clamp(geo.anchorTop - geo.anchorScreenY);
    const anchoredScreenTop = geo.fileTop - anchorTarget;
    const anchoredScreenBottom = geo.fileBottom - anchorTarget;

    if (anchoredScreenTop >= 0 && anchoredScreenBottom <= bandBottom) {
      return { target: anchorTarget, mode: 'anchor' };
    }

    if (anchoredScreenBottom > bandBottom) {
      const minimal = geo.fileBottom - bandBottom;
      // The anchor stays on screen as long as the needed scroll does not pass it.
      if (minimal <= geo.anchorTop) {
        return { target: clamp(Math.max(minimal, anchorTarget)), mode: 'anchor-limited' };
      }
      return { target: centered, mode: 'center' };
    }

    return {
      target: clamp(Math.min(anchorTarget, geo.fileTop - bandTop)),
      mode: 'anchor-up',
    };
  }

  armRevealGuard(container, fileEl, target) {
    this.revealGuard = {
      container,
      fileEl,
      target,
      until: performance.now() + REVEAL_CORRECTION_MS,
      corrected: false,
    };
  }

  // The native auto-reveal may scroll after ours; correct it once, and only when
  // the row left the comfortable band.
  handleRevealScroll(container) {
    const guard = this.revealGuard;
    if (!guard) return;
    if (performance.now() > guard.until) {
      this.revealGuard = null;
      return;
    }
    if (guard.container !== container || guard.corrected) return;
    if (!guard.fileEl.isConnected) {
      this.revealGuard = null;
      return;
    }
    if (Math.abs(container.scrollTop - guard.target) < 2) return;
    if (this.isFileComfortable(container, guard.fileEl)) {
      this.revealGuard = null;
      return;
    }
    const actual = Math.round(container.scrollTop);
    guard.corrected = true;
    this.setContainerScroll(container, guard.target);
    this.debug.record('reveal.corrected', {
      actual,
      target: Math.round(guard.target),
    });
  }

  isFileComfortable(container, fileEl) {
    if (!fileEl.isConnected) return true;
    const containerRect = container.getBoundingClientRect();
    const rect = fileEl.getBoundingClientRect();
    const top = rect.top - containerRect.top;
    const bottom = rect.bottom - containerRect.top;
    return top >= 0 && bottom <= container.clientHeight * REVEAL_BAND_BOTTOM;
  }

  setContainerScroll(container, top) {
    const previous = container.style.scrollBehavior;
    container.style.scrollBehavior = 'auto';
    container.scrollTop = top;
    if (previous) container.style.scrollBehavior = previous;
    else container.style.removeProperty('scroll-behavior');
  }

  getNavContainer() {
    for (const selector of EXPLORER_SELECTORS) {
      const el = document.querySelector(selector);
      if (!el) continue;
      if (el.classList.contains('nav-files-container')) return el;
      const nested = el.querySelector('.nav-files-container');
      if (nested) return nested;
    }
    return document.querySelector('.nav-files-container');
  }

  findFolderEl(view, path) {
    for (const el of view.containerEl.querySelectorAll('.nav-folder, .tree-item-folder')) {
      if (folderPathOf(el) === path) return el;
    }
    return null;
  }

  findFileEl(view, path) {
    for (const el of view.containerEl.querySelectorAll('.nav-file-title[data-path]')) {
      if (el.getAttribute('data-path') === path) return el;
    }
    return null;
  }

  findFileElIn(container, path) {
    for (const el of container.querySelectorAll('.nav-file-title[data-path]')) {
      if (el.getAttribute('data-path') === path) return el;
    }
    return null;
  }

  clickFolderIcon(el) {
    const icon = el.querySelector(ICON_SELECTORS);
    if (!icon) return;
    this.suppressAccordionUntil = Math.max(this.suppressAccordionUntil, performance.now() + 200);
    icon.click();
  }

  startFrameSampling(file) {
    if (!this.settings.debugLogging) return;
    if (this.frameHandle) window.cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;

    const startedAt = performance.now();
    let frame = 0;
    this.debug.record('sample.start', { file: file.path });

    const container = this.getNavContainer();
    if (container) {
      this.debug.record('explorer.style', {
        scrollBehavior: window.getComputedStyle(container).scrollBehavior,
        top: Math.round(container.scrollTop),
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
      });
    }

    const tick = () => {
      if (!this.settings.debugLogging) {
        this.frameHandle = null;
        return;
      }
      frame += 1;
      const el = this.getNavContainer();
      if (el) {
        const target = this.findFileElIn(el, file.path);
        const containerRect = el.getBoundingClientRect();
        const targetRect = target ? target.getBoundingClientRect() : null;
        const data = {
          frame,
          top: Math.round(el.scrollTop),
          targetTop: targetRect ? Math.round(targetRect.top - containerRect.top) : null,
          height: el.scrollHeight,
        };
        if (frame % 5 === 0) {
          data.expanded = el.querySelectorAll('.nav-folder:not(.is-collapsed)').length;
          data.rows = el.querySelectorAll('.nav-folder, .nav-file').length;
        }
        this.debug.record('frame', data);
      }
      if (performance.now() - startedAt < SAMPLE_DURATION_MS) {
        this.frameHandle = window.requestAnimationFrame(tick);
      } else {
        this.frameHandle = null;
        this.debug.record('sample.end', { frames: frame });
      }
    };
    this.frameHandle = window.requestAnimationFrame(tick);
  }

  async exportDebugLog() {
    if (!this.debug.entries.length) {
      new Notice(t('暂无调试日志，请先开启记录并复现一次切换。', 'No debug entries. Enable logging and reproduce a switch first.'));
      return false;
    }
    const manifest = this.manifest;
    const content = this.debug.format(manifest);
    const folder = await this.resolveDebugFolder();
    const prefix = this.settings.debugBypass ? '切换-旁路' : '切换';
    const filePath = `${folder}/${prefix}-${formatTimestamp(new Date())}.log`;
    try {
      await this.writeVaultFile(filePath, content);
      new Notice(t(`调试日志已导出：${filePath}`, `Debug log exported: ${filePath}`), 8000);
      return true;
    } catch (error) {
      console.error('[folder-focus-collapse] failed to export debug log', error);
      new Notice(t(`导出失败：${error}`, `Export failed: ${error}`), 8000);
      return false;
    }
  }

  async resolveDebugFolder() {
    const adapter = this.app.vault.adapter;
    const project = '工作管理/Custom/obsidian 文件树聚焦折叠插件开发';
    try {
      if (await adapter.exists(project)) return `${project}/调试日志`;
    } catch (error) {
      // Fall through to the plugin folder.
    }
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  async writeVaultFile(filePath, content) {
    const adapter = this.app.vault.adapter;
    const segments = filePath.split('/');
    let current = '';
    for (const segment of segments.slice(0, -1)) {
      current = current ? `${current}/${segment}` : segment;
      if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
    await adapter.write(filePath, content);
  }

  setupExplorer() {
    this.detachExplorerListeners();

    const explorer = this.getFileExplorerElement();
    if (!explorer) {
      this.debug.record('explorer.missing', {});
      return;
    }
    this.debug.record('explorer.setup', { selectorClass: explorer.className });

    this.observer = new MutationObserver((mutations) => {
      this.debug.recordMutations(mutations);
      if (this.settings.debugBypass) return;
      if (performance.now() < this.suppressAccordionUntil) return;
      for (const mutation of mutations) {
        if (
          mutation.type === 'attributes' &&
          mutation.attributeName === 'class' &&
          mutation.target.classList.contains('is-collapsed')
        ) {
          this.debug.record('accordion.cascade', {
            path: folderPathOf(mutation.target),
          });
          this.collapseChildFolders(mutation.target);
        }
      }
    });
    this.observer.observe(explorer, {
      attributes: true,
      subtree: true,
      attributeFilter: ['class'],
    });

    this.clickHandler = (event) => {
      if (this.settings.debugBypass) return;
      if (!this.settings.exclusiveAccordionEnabled) return;
      if (performance.now() < this.suppressAccordionUntil) return;

      const source = event.target instanceof Element ? event.target : null;
      const target = source ? source.closest('.nav-folder, .tree-item-folder') : null;
      if (!target) return;
      this.debug.record('accordion.click', { path: folderPathOf(target) });

      window.setTimeout(() => {
        if (!target.classList.contains('is-collapsed')) this.collapseOtherFolders(target);
      }, 0);
    };
    explorer.addEventListener('click', this.clickHandler, true);
  }

  detachExplorerListeners() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    const explorer = this.getFileExplorerElement();
    if (explorer && this.clickHandler) {
      explorer.removeEventListener('click', this.clickHandler, true);
    }
    this.clickHandler = null;
  }

  getFileExplorerElement() {
    for (const selector of EXPLORER_SELECTORS) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  collapseAllTopFolders() {
    if (this.settings.debugBypass) return;
    const explorer = this.getFileExplorerElement();
    if (!explorer) return;
    this.suppressAccordionUntil = performance.now() + 300;
    explorer.querySelectorAll('.nav-folder, .tree-item-folder').forEach((folder) => {
      if (!folder.classList.contains('is-collapsed')) {
        folder.querySelector(ICON_SELECTORS)?.click();
      }
    });
  }

  async collapseChildFolders(folder) {
    const container = folder.querySelector('.nav-folder-children, .child-folder-container');
    if (!container) return;
    const subs = container.querySelectorAll('.nav-folder, .child-folder');
    this.debug.record('accordion.collapseChildren', {
      path: folderPathOf(folder),
      count: subs.length,
    });
    await Promise.all(Array.from(subs).map((sub) => this.collapseSubfolder(sub)));
  }

  collapseSubfolder(subfolder) {
    return new Promise((resolve) => {
      const localObserver = new MutationObserver((mutations) => {
        if (
          mutations.some(
            (mutation) =>
              mutation.type === 'attributes' &&
              mutation.attributeName === 'class' &&
              mutation.target.classList.contains('is-collapsed')
          )
        ) {
          localObserver.disconnect();
          resolve();
        }
      });
      localObserver.observe(subfolder, { attributes: true, attributeFilter: ['class'] });

      const icon = subfolder.querySelector(ICON_SELECTORS);
      if (icon && !subfolder.classList.contains('is-collapsed')) {
        try {
          icon.click();
          sleep(150).then(() => {
            localObserver.disconnect();
            resolve();
          });
        } catch (error) {
          localObserver.disconnect();
          resolve();
        }
      } else {
        localObserver.disconnect();
        resolve();
      }
    });
  }

  collapseOtherFolders(openedFolder) {
    const explorer = this.getFileExplorerElement();
    if (!explorer) return;
    let collapsed = 0;
    explorer.querySelectorAll('.nav-folder, .tree-item-folder').forEach((folder) => {
      if (
        folder === openedFolder ||
        folder.contains(openedFolder) ||
        openedFolder.contains(folder)
      ) {
        return;
      }
      if (!folder.classList.contains('is-collapsed')) {
        folder.querySelector(ICON_SELECTORS)?.click();
        collapsed += 1;
      }
    });
    this.debug.record('accordion.others', { count: collapsed });
  }

  startInactivityTimer() {
    this.stopInactivityTimer();
    if (this.settings.debugBypass) return;

    const timeout = Math.max(1, this.settings.inactivityMinutes) * 60 * 1000;

    this.inactivityTimer = window.setTimeout(() => this.collapseAllTopFolders(), timeout);
    this.inactivityResetHandler = () => {
      if (!this.settings.autoCollapseEnabled) return;
      if (this.inactivityTimer) window.clearTimeout(this.inactivityTimer);
      this.inactivityTimer = window.setTimeout(() => this.collapseAllTopFolders(), timeout);
    };

    ['mousemove', 'keydown', 'click', 'focus'].forEach((event) => {
      window.addEventListener(event, this.inactivityResetHandler, true);
    });
  }

  stopInactivityTimer() {
    if (this.inactivityTimer) {
      window.clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    if (this.inactivityResetHandler) {
      ['mousemove', 'keydown', 'click', 'focus'].forEach((event) => {
        window.removeEventListener(event, this.inactivityResetHandler, true);
      });
      this.inactivityResetHandler = null;
    }
  }
}

class FolderFocusCollapseSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('ffc-settings');

    this.addLanguageRow(containerEl);

    this.addSection(containerEl, t('触发时机', 'Triggers'), (group) => {
      this.addToggle(
        group,
        'collapseOnEditorClick',
        t('点击正文时收拢', 'Collapse on editor click'),
        t(
          '在正文中点击、把插入光标放进当前文档时，折叠文件树中与该文档无关的目录。',
          "Collapses folders outside the active note's path when you click into the editor."
        )
      );
      this.addToggle(
        group,
        'collapseOnActiveLeafChange',
        t('切换标签页时收拢', 'Collapse on tab switch'),
        t(
          '活动标签页发生变化时同样执行收拢。注意：点击文件树中的文件也会触发。',
          'Also collapses when the active tab changes. Note: clicking a file in the explorer triggers this too.'
        )
      );
      this.addToggle(
        group,
        'collapseOnFileOpen',
        t('打开文件时收拢', 'Collapse on file open'),
        t(
          '通过快速切换、搜索或快捷键打开文件时也执行收拢，与其它两种触发默认同时开启。',
          'Also collapses when a file opens via quick switcher, search, or hotkeys. Enabled by default together with the other two triggers.'
        )
      );
    });

    this.addSection(containerEl, t('折叠范围', 'Collapse scope'), (group) => {
      const keepSetting = new Setting(group).setName(
        t('保持展开的目录', 'Folders to keep open')
      );
      this.setListDescription(
        keepSetting,
        t(
          '收拢时哪些文件夹不被折叠。三种模式都不会主动展开任何目录，只决定保留范围。以 工作管理/技术沉淀/深度学习框架/笔记.md 为例：',
          'Which folders survive a collapse. None of the three modes opens folders on its own; they only define what stays open. For 工作管理/技术沉淀/深度学习框架/note.md:'
        ),
        [
          t(
            '仅当前文件路径：只保留三层祖先目录，其它全部折叠。',
            'Path only: keeps the three ancestor folders and collapses everything else.'
          ),
          t(
            '路径 + 同级目录：额外保留「深度学习框架」下的直接子文件夹，其内部更深的目录仍会折叠。',
            'Path + sibling folders: also keeps the direct subfolders of 深度学习框架; deeper folders inside them still collapse.'
          ),
          t(
            '路径 + 当前目录整层：「深度学习框架」整棵子树保持原样，只折叠其外部目录。',
            'Path + current folder subtree: leaves the entire 深度学习框架 subtree untouched and collapses only folders outside it.'
          ),
        ],
        t(
          '文件位于库根目录时，整层模式会保留整棵树。',
          'When the note sits at the vault root, the subtree mode keeps the whole tree.'
        )
      );
      keepSetting.addDropdown((dropdown) => {
        dropdown.addOption('path', t('仅当前文件路径', 'Active file path only'));
        dropdown.addOption('path-siblings', t('路径 + 同级目录', 'Path + sibling folders'));
        dropdown.addOption('path-subtree', t('路径 + 当前目录整层', 'Path + current folder subtree'));
        dropdown.setValue(this.plugin.settings.keepMode).onChange(async (value) => {
          this.plugin.settings.keepMode = value;
          await this.plugin.saveSettings();
        });
      });
    });

    this.addSection(containerEl, t('文件滚动与高亮', 'File scrolling and highlight'), (group) => {
      const revealMode = this.plugin.settings.revealMode;
      // Declared before the rows so the dropdown can update the center row
      // in place, without re-rendering the settings tab.
      let applyCenterRowState = null;

      new Setting(group)
        .setName(t('当前文件滚动方式', 'Active file scroll mode'))
        .setDesc(
          t(
            '决定收拢后文件树如何把当前文件带进视野。顶部锚定优先：锁住顶层目录的位置，只在当前文件会掉出中部时让步；始终居中：每次都把当前文件放到固定高度；仅保证可见：只在完全不可见时贴近边缘；不滚动：只收拢，不改变滚动位置。',
            'How the explorer brings the active file into view after collapsing. Anchor first: holds the top-level folder in place and concedes only when the note would leave the middle band; always center: places the note at the fixed height every time; only keep visible: scrolls just enough to make the note visible; no scrolling: collapses only and never moves the scroll position.'
          )
        )
        .addDropdown((dropdown) => {
          dropdown.addOption('anchor', t('顶部锚定优先', 'Anchor first'));
          dropdown.addOption('center', t('始终居中', 'Always center'));
          dropdown.addOption('nearest', t('仅保证可见', 'Only keep visible'));
          dropdown.addOption('off', t('不滚动（只收拢）', 'No scrolling (collapse only)'));
          dropdown.setValue(revealMode).onChange(async (value) => {
            this.plugin.settings.revealMode = value;
            if (applyCenterRowState) applyCenterRowState(value);
            await this.plugin.saveSettings();
          });
        });

      const centerRow = new Setting(group)
        .setName(t('居中位置', 'Center position'))
        .setDesc(
          t(
            '当前文件行上边缘在文件树容器高度中的位置比例。40% 表示大约停在距顶部四成处（容器高 600px 时约 240px），即中部偏上。仅在「始终居中」，或「顶部锚定优先」因祖先链过长而转为居中时生效；文件能在顶层目录不动的前提下完整显示时，此项不生效。比例越小文件越靠上，越大越靠下。当前滚动方式为「仅保证可见」或「不滚动」时，此行置灰不可操作。',
            "Where the active row's top edge sits inside the explorer, as a share of its height. 40% places it about four tenths from the top (roughly 240px in a 600px pane), slightly above the middle. It applies only with \"Always center\", or when \"Anchor first\" falls back to centering because the ancestor chain is too long; it has no effect when the note fits while the top-level folder stays put. A smaller value moves the row up, a larger one down. This row is greyed out when the scroll mode is \"Only keep visible\" or \"No scrolling\"."
          )
        );
      let centerSlider = null;
      centerRow.addSlider((slider) => {
        centerSlider = slider;
        slider
          .setLimits(30, 55, 5)
          .setValue(this.plugin.settings.revealCenterRatio)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.revealCenterRatio = value;
            await this.plugin.saveSettings();
          });
      });
      applyCenterRowState = (mode) => {
        const enabled = mode === 'anchor' || mode === 'center';
        centerRow.setDisabled(!enabled);
        centerRow.settingEl.classList.toggle('ffc-row-disabled', !enabled);
        if (centerSlider) centerSlider.setDisabled(!enabled);
      };
      applyCenterRowState(revealMode);

      new Setting(group)
        .setName(t('当前文件高亮', 'Active file highlight'))
        .setDesc(
          t(
            '强调色底：用主题强调色铺满当前文件行；左侧强调条：保留底色并加定位竖条；保持主题：不改动原生外观。',
            'Accent fill: paints the active row with the theme accent; left bar: keeps the theme background and adds a marker; theme: leaves the native look untouched.'
          )
        )
        .addDropdown((dropdown) => {
          dropdown.addOption('accent', t('强调色底', 'Accent fill'));
          dropdown.addOption('bar', t('左侧强调条', 'Left bar'));
          dropdown.addOption('off', t('保持主题', 'Theme default'));
          dropdown.setValue(this.plugin.settings.activeFileHighlight).onChange(async (value) => {
            this.plugin.settings.activeFileHighlight = value;
            await this.plugin.saveSettings();
            this.plugin.applyHighlightClass();
          });
        });
    });

    this.addSection(containerEl, t('文件树交互', 'File explorer interaction'), (group) => {
      this.addToggle(
        group,
        'exclusiveAccordionEnabled',
        t('手动展开时折叠其它目录', 'Exclusive accordion'),
        t(
          '手动展开一个目录时，折叠该路径之外的其它目录。',
          'Collapses every other folder when you expand one.'
        )
      );
      this.addToggle(
        group,
        'autoCollapseEnabled',
        t('闲置后自动折叠', 'Collapse after inactivity'),
        t(
          '一段时间没有操作后，折叠全部父目录。',
          'Collapses all parent folders after a period of inactivity.'
        ),
        (value) => {
          if (value) this.plugin.startInactivityTimer();
          else this.plugin.stopInactivityTimer();
        }
      );

      new Setting(group)
        .setName(t('闲置时长（分钟）', 'Inactivity duration (minutes)'))
        .setDesc(t('闲置多少分钟后触发折叠。', 'Minutes of inactivity before collapsing.'))
        .addSlider((slider) =>
          slider
            .setLimits(1, 60, 1)
            .setValue(this.plugin.settings.inactivityMinutes)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.inactivityMinutes = value;
              await this.plugin.saveSettings();
              if (this.plugin.settings.autoCollapseEnabled) this.plugin.startInactivityTimer();
            })
        );
    });

    this.addSection(containerEl, t('调试', 'Debug'), (group) => {
      this.addToggle(
        group,
        'debugLogging',
        t('记录切换调试日志', 'Record switch debug log'),
        t(
          '开启后在内存中记录标签切换的每一步，用命令「导出文件树切换调试日志」落盘。测量期间不写文件，避免干扰。',
          'Records every step of a tab switch in memory. Export it with the command "Export file-explorer switch debug log". No file writes during measurement.'
        ),
        (value) => {
          if (value) {
            this.plugin.debug.clear();
            this.plugin.debug.record('debug.start', {});
          }
        }
      );

      this.addToggle(
        group,
        'debugBypass',
        t('旁路插件（只观测原生）', 'Bypass plugin (observe native)'),
        t(
          '开启后本插件不执行任何收拢，也不接管手风琴与闲置折叠，只记录事件、逐帧树高与滚动，用于和原生「自动显示当前文件」对照。导出文件名带「旁路」前缀。',
          'The plugin stops collapsing and stops managing the accordion, keeping only event, per-frame height, and scroll records, so the native reveal behaviour can be measured and compared. Exported file names carry a bypass marker.'
        ),
        (value) => {
          this.plugin.stopInactivityTimer();
          if (!value && this.plugin.settings.autoCollapseEnabled) this.plugin.startInactivityTimer();
        }
      );

      const exportRow = new Setting(group)
        .setName(t('导出调试日志', 'Export debug log'))
        .setDesc(
          t(
            '把当前内存中的记录写入项目目录下的「调试日志」文件夹。',
            'Writes the in-memory records to the debug log folder in the project directory.'
          )
        );
      exportRow.addButton((button) => {
        button.setButtonText(t('导出', 'Export')).setCta();
        button.buttonEl.addClass('ffc-setting-btn');
        button.onClick(async () => {
          const ok = await this.plugin.exportDebugLog();
          if (ok) this.flashButtonFeedback(button, t('已导出', 'Exported'));
        });
      });
    });

    const resetRow = new Setting(containerEl)
      .setName(t('恢复默认设置', 'Reset all settings'))
      .setDesc(
        t(
          '把本插件的全部设置恢复为默认值。',
          'Restores every setting of this plugin to its default value.'
        )
      );
    resetRow.settingEl.addClass('ffc-row-sep-above');
    resetRow.addButton((button) => {
      button.setButtonText(t('恢复默认设置', 'Reset all settings')).setCta();
      button.buttonEl.addClass('ffc-setting-btn');
      button.onClick(() => this.resetAllSettings(button));
    });

    this.reflowDescriptions();
  }

  addLanguageRow(containerEl) {
    const current = this.plugin.settings.uiLanguage;
    const effective = this.plugin.effectiveLanguage();
    const effectiveName = effective === 'zh' ? '中文' : 'English';
    const row = new Setting(containerEl)
      .setName(t('界面语言', 'Interface language'))
      .setDesc(
        current === 'auto'
          ? t(
              `仅影响本插件的设置页与提示文字，不改变 Obsidian 界面语言。当前跟随 Obsidian（${effectiveName}）。`,
              `Affects only this plugin's settings and notices, not the Obsidian UI language. Currently following Obsidian (${effectiveName}).`
            )
          : t(
              '仅影响本插件的设置页与提示文字，不改变 Obsidian 界面语言。',
              "Affects only this plugin's settings and notices, not the Obsidian UI language."
            )
      );

    const addLanguageButton = (label, value) => {
      row.addButton((button) => {
        button.setButtonText(label);
        button.buttonEl.addClass('ffc-setting-btn');
        if (current === value) {
          button.setCta();
          button.buttonEl.addClass('ffc-btn-active');
        }
        button.onClick(async () => {
          this.plugin.settings.uiLanguage = value;
          await this.plugin.saveSettings();
          this.plugin.applyLanguage();
          this.display();
        });
      });
    };
    addLanguageButton('中文', 'zh');
    addLanguageButton('English', 'en');
  }

  setListDescription(setting, lead, lines, tail) {
    setting.setDesc(lead);
    const descEl =
      setting.descEl || setting.settingEl.querySelector('.setting-item-description');
    if (!descEl) return;
    const list = descEl.createEl('ul', { cls: 'ffc-desc-list' });
    for (const line of lines) list.createEl('li', { text: line });
    if (tail) descEl.createEl('div', { text: tail, cls: 'ffc-desc-tail' });
  }

  addSection(root, heading, build) {
    new Setting(root).setName(heading).setHeading();
    const group = root.createDiv({ cls: 'ffc-settings-group' });
    build(group);
  }

  addToggle(parent, key, name, desc, onChange) {
    new Setting(parent)
      .setName(name)
      .setDesc(desc)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
          this.plugin.settings[key] = value;
          await this.plugin.saveSettings();
          if (onChange) onChange(value);
        })
      );
  }

  reflowDescriptions() {
    this.containerEl.querySelectorAll('.setting-item').forEach((item) => {
      const desc = item.querySelector('.setting-item-description');
      if (!desc || desc.parentElement === item) return;
      item.appendChild(desc);
    });
  }

  resetAllSettings(button) {
    this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.plugin.saveSettings();
    this.plugin.applyLanguage();
    this.plugin.applyHighlightClass();
    if (this.plugin.settings.autoCollapseEnabled) this.plugin.startInactivityTimer();
    else this.plugin.stopInactivityTimer();
    this.plugin.debug.clear();

    this.flashResetFeedback(button);
    window.setTimeout(() => {
      if (this.containerEl.isConnected) this.display();
    }, 1600);
  }

  flashResetFeedback(button) {
    this.flashButtonFeedback(button, t('已重置', 'Reset'));
  }

  flashButtonFeedback(button, label) {
    const el = button.buttonEl;
    if (el.classList.contains('ffc-btn-pressed')) return;

    const originalText = el.textContent ?? '';
    el.style.minWidth = `${el.offsetWidth}px`;
    button.setDisabled(true);
    button.setButtonText(label);
    el.style.setProperty('background-color', 'var(--color-green)', 'important');
    el.style.setProperty('color', '#fff', 'important');
    el.style.setProperty('opacity', '1', 'important');
    el.classList.add('ffc-btn-pressed');

    window.setTimeout(() => {
      button.setDisabled(false);
      button.setButtonText(originalText);
      el.classList.remove('ffc-btn-pressed');
      el.style.removeProperty('background-color');
      el.style.removeProperty('color');
      el.style.removeProperty('opacity');
      el.style.removeProperty('min-width');
    }, 1500);
  }
}

module.exports = FolderFocusCollapsePlugin;
