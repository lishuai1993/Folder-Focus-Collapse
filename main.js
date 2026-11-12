const { Plugin, PluginSettingTab, Setting, TFolder, Notice, apiVersion } = require('obsidian');

const DEFAULT_SETTINGS = {
  collapseOnEditorClick: true,
  collapseOnActiveLeafChange: false,
  collapseOnFileOpen: false,
  keepMode: 'path',
  revealActiveFile: true,
  autoCollapseEnabled: true,
  inactivityMinutes: 5,
  exclusiveAccordionEnabled: true,
  debugLogging: false,
  debugBypass: false,
};

const KEEP_MODES = ['path', 'path-siblings', 'path-subtree'];
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

function getLanguage() {
  try {
    const raw = window.localStorage.getItem('language') || '';
    return raw.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch (error) {
    return 'zh';
  }
}

const t = (zh, en) => (getLanguage() === 'zh' ? zh : en);

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
    this.debug = new DebugLog(this);

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
        if (!this.settings.debugLogging) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (!target.classList.contains('nav-files-container')) return;
        this.debug.record('scroll', { top: Math.round(target.scrollTop) });
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
    if (this.frameHandle) window.cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
    this.detachExplorerListeners();
    this.stopInactivityTimer();
  }

  async loadSettings() {
    const loaded = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    if (!KEEP_MODES.includes(this.settings.keepMode)) {
      this.settings.keepMode = DEFAULT_SETTINGS.keepMode;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
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

    for (const leaf of leaves) {
      const view = leaf.view;
      if (!view || !view.containerEl) continue;
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
        if (this.settings.revealActiveFile) this.revealFile(view, file);
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

  revealFile(view, file) {
    const item = view.fileItems && view.fileItems[file.path];
    const el = (item && item.selfEl) || this.findFileEl(view, file.path);
    if (!el || typeof el.scrollIntoView !== 'function') {
      this.debug.record('reveal.skip', { file: file.path });
      return;
    }
    const container = this.getNavContainer();
    const before = container ? Math.round(container.scrollTop) : null;
    el.scrollIntoView({ block: 'nearest' });
    const after = container ? Math.round(container.scrollTop) : null;
    this.debug.record('reveal', { before, after, changed: before !== after });
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
          '通过快速切换、搜索或快捷键打开文件时也执行收拢。默认关闭，避免点击文件树时反复收拢。',
          'Also collapses when a file opens via quick switcher, search, or hotkeys. Off by default to avoid churn when clicking files in the explorer.'
        )
      );
    });

    this.addSection(containerEl, t('折叠范围', 'Collapse scope'), (group) => {
      new Setting(group)
        .setName(t('保持展开的目录', 'Folders to keep open'))
        .setDesc(
          t(
            '仅当前文件路径：只展开该文件的祖先目录。路径 + 同级目录：保留当前目录下的兄弟文件夹。路径 + 当前目录整层：当前目录整棵子树保持原状。',
            "Active file path only: expand just the note's ancestor folders. Path + sibling folders: keep the folders beside the note. Path + current folder subtree: leave the note's whole folder untouched."
          )
        )
        .addDropdown((dropdown) => {
          dropdown.addOption('path', t('仅当前文件路径', 'Active file path only'));
          dropdown.addOption('path-siblings', t('路径 + 同级目录', 'Path + sibling folders'));
          dropdown.addOption('path-subtree', t('路径 + 当前目录整层', 'Path + current folder subtree'));
          dropdown.setValue(this.plugin.settings.keepMode).onChange(async (value) => {
            this.plugin.settings.keepMode = value;
            await this.plugin.saveSettings();
          });
        });

      this.addToggle(
        group,
        'revealActiveFile',
        t('折叠后定位当前文件', 'Reveal active file after collapse'),
        t(
          '收拢后确保当前文件所在行留在文件树可视区内。',
          'Keeps the active note visible in the file explorer after collapsing.'
        )
      );
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
