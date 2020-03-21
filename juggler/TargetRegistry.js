const {EventEmitter} = ChromeUtils.import('resource://gre/modules/EventEmitter.jsm');
const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {SimpleChannel} = ChromeUtils.import('chrome://juggler/content/SimpleChannel.js');
const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");
const {BrowserContext} = ChromeUtils.import("chrome://juggler/content/BrowserContextManager.js");

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

const helper = new Helper();

class TargetRegistry {
  static instance() {
    return TargetRegistry._instance || null;
  }

  static initialize(mainWindow, contextManager) {
    if (TargetRegistry._instance)
      return;
    TargetRegistry._instance = new TargetRegistry(mainWindow, contextManager);
  }

  constructor(mainWindow, contextManager) {
    EventEmitter.decorate(this);

    this._mainWindow = mainWindow;
    this._contextManager = contextManager;
    this._targets = new Map();

    this._browserTarget = new BrowserTarget();
    this._targets.set(this._browserTarget.id(), this._browserTarget);
    this._tabToTarget = new Map();

    for (const tab of this._mainWindow.gBrowser.tabs)
      this._createTargetForTab(tab);
    this._mainWindow.gBrowser.tabContainer.addEventListener('TabOpen', event => {
      const target = this._createTargetForTab(event.target);
      // If we come here, content will have juggler script from the start,
      // and we should wait for initial navigation, unless the tab was window.open'ed.
      target._waitForInitialNavigation = !event.target.linkedBrowser.hasContentOpener;
      // For pages created before we attach to them, we don't wait for initial
      // navigation (target._waitForInitialNavigation is false by default).
    });
    this._mainWindow.gBrowser.tabContainer.addEventListener('TabClose', event => {
      const tab = event.target;
      const target = this._tabToTarget.get(tab);
      if (!target)
        return;
      this._targets.delete(target.id());
      this._tabToTarget.delete(tab);
      target.dispose();
      this.emit(TargetRegistry.Events.TargetDestroyed, target);
    });
    Services.obs.addObserver(this, 'oop-frameloader-crashed');
  }

  pageTargets(browserContextId) {
    const browserContext = this._contextManager.browserContextForId(browserContextId);
    const pageTargets = [...this._targets.values()].filter(target => target instanceof PageTarget);
    return pageTargets.filter(target => target._browserContext === browserContext);
  }

  async newPage({browserContextId}) {
    const browserContext = this._contextManager.browserContextForId(browserContextId);
    const tab = this._mainWindow.gBrowser.addTab('about:blank', {
      userContextId: browserContext.userContextId,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    this._mainWindow.gBrowser.selectedTab = tab;
    const target = this._tabToTarget.get(tab);
    await target._contentReadyPromise;
    return target.id();
  }

  async closePage(targetId, runBeforeUnload = false) {
    const tab = this.tabForTarget(targetId);
    await this._mainWindow.gBrowser.removeTab(tab, {
      skipPermitUnload: !runBeforeUnload,
    });
  }

  targets() {
    return Array.from(this._targets.values());
  }

  targetInfo(targetId) {
    const target = this._targets.get(targetId);
    return target ? target.info() : null;
  }

  browserTargetInfo() {
    return this._browserTarget.info();
  }

  tabForTarget(targetId) {
    const target = this._targets.get(targetId);
    if (!target)
      throw new Error(`Target "${targetId}" does not exist!`);
    if (!(target instanceof PageTarget))
      throw new Error(`Target "${targetId}" is not a page!`);
    return target._tab;
  }

  contentChannelForTarget(targetId) {
    const target = this._targets.get(targetId);
    if (!target)
      throw new Error(`Target "${targetId}" does not exist!`);
    if (!(target instanceof PageTarget))
      throw new Error(`Target "${targetId}" is not a page!`);
    return target._channel;
  }

  targetForId(targetId) {
    return this._targets.get(targetId);
  }

  targetForBrowser(browser) {
    const tab = this._mainWindow.gBrowser.getTabForBrowser(browser);
    return tab ? this._tabToTarget.get(tab) : undefined;
  }

  browserContextForBrowser(browser) {
    const tab = this._mainWindow.gBrowser.getTabForBrowser(browser);
    return tab ? this._contextManager.browserContextForUserContextId(tab.userContextId) : undefined;
  }

  _createTargetForTab(tab) {
    if (this._tabToTarget.has(tab))
      throw new Error(`Internal error: two targets per tab`);
    const openerTarget = tab.openerTab ? this._tabToTarget.get(tab.openerTab) : null;
    const target = new PageTarget(this, tab, this._contextManager.browserContextForUserContextId(tab.userContextId), openerTarget);
    this._targets.set(target.id(), target);
    this._tabToTarget.set(tab, target);
    this.emit(TargetRegistry.Events.TargetCreated, target);
    return target;
  }

  observe(subject, topic, data) {
    if (topic === 'oop-frameloader-crashed') {
      const browser = subject.ownerElement;
      if (!browser)
        return;
      const target = this.targetForBrowser(browser);
      if (!target)
        return;
      this.emit(TargetRegistry.Events.TargetCrashed, target.id());
      return;
    }
  }
}

class PageTarget {
  constructor(registry, tab, browserContext, opener) {
    this._targetId = helper.generateId();
    this._registry = registry;
    this._tab = tab;
    this._browserContext = browserContext;
    this._url = '';
    this._openerId = opener ? opener.id() : undefined;
    this._channel = SimpleChannel.createForMessageManager(`browser::page[${this._targetId}]`, tab.linkedBrowser.messageManager);

    const navigationListener = {
      QueryInterface: ChromeUtils.generateQI([ Ci.nsIWebProgressListener]),
      onLocationChange: (aWebProgress, aRequest, aLocation) => this._onNavigated(aLocation),
    };
    this._eventListeners = [
      helper.addProgressListener(tab.linkedBrowser, navigationListener, Ci.nsIWebProgress.NOTIFY_LOCATION),
      helper.addMessageListener(tab.linkedBrowser.messageManager, 'juggler:content-ready', {
        receiveMessage: () => this._onContentReady()
      }),
    ];

    this._contentReadyPromise = new Promise(f => this._contentReadyCallback = f);
    this._waitForInitialNavigation = false;

    if (browserContext) {
      this._eventListeners.push(helper.on(browserContext, BrowserContext.Events.ScriptToEvaluateOnNewDocumentAdded, script => {
        this._channel.connect('').emit('addScriptToEvaluateOnNewDocument', {script});
      }));
    }

    if (browserContext && browserContext.options.viewport)
      this.setViewportSize(browserContext.options.viewport.viewportSize);
  }

  setViewportSize(viewportSize) {
    if (viewportSize) {
      const {width, height} = viewportSize;
      this._tab.linkedBrowser.style.setProperty('min-width', width + 'px');
      this._tab.linkedBrowser.style.setProperty('min-height', height + 'px');
      this._tab.linkedBrowser.style.setProperty('max-width', width + 'px');
      this._tab.linkedBrowser.style.setProperty('max-height', height + 'px');
    } else {
      this._tab.linkedBrowser.style.removeProperty('min-width');
      this._tab.linkedBrowser.style.removeProperty('min-height');
      this._tab.linkedBrowser.style.removeProperty('max-width');
      this._tab.linkedBrowser.style.removeProperty('max-height');
    }
    const rect = this._tab.linkedBrowser.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  _onContentReady() {
    const sessionIds = [];
    const data = { sessionIds, target: this };
    this._registry.emit(TargetRegistry.Events.PageTargetReady, data);
    this._contentReadyCallback();
    return {
      browserContextOptions: this._browserContext ? this._browserContext.options : {},
      waitForInitialNavigation: this._waitForInitialNavigation,
      sessionIds
    };
  }

  id() {
    return this._targetId;
  }

  info() {
    return {
      targetId: this.id(),
      type: 'page',
      browserContextId: this._browserContext ? this._browserContext.browserContextId : undefined,
      openerId: this._openerId,
    };
  }

  _onNavigated(aLocation) {
    this._url = aLocation.spec;
    this._browserContext.grantPermissionsToOrigin(this._url);
  }

  async ensurePermissions(permissions) {
    await this._channel.connect('').send('ensurePermissions', permissions).catch(e => void e);
  }

  dispose() {
    helper.removeListeners(this._eventListeners);
  }
}

class BrowserTarget {
  id() {
    return 'target-browser';
  }

  info() {
    return {
      targetId: this.id(),
      type: 'browser',
    }
  }
}

TargetRegistry.Events = {
  TargetCreated: Symbol('TargetRegistry.Events.TargetCreated'),
  TargetDestroyed: Symbol('TargetRegistry.Events.TargetDestroyed'),
  TargetCrashed: Symbol('TargetRegistry.Events.TargetCrashed'),
  PageTargetReady: Symbol('TargetRegistry.Events.PageTargetReady'),
};

var EXPORTED_SYMBOLS = ['TargetRegistry'];
this.TargetRegistry = TargetRegistry;
