"use strict";

const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");
const {TargetRegistry} = ChromeUtils.import("chrome://juggler/content/TargetRegistry.js");
const {BrowserContextManager} = ChromeUtils.import("chrome://juggler/content/BrowserContextManager.js");
const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const helper = new Helper();

class TargetHandler {
  /**
   * @param {ChromeSession} session
   */
  constructor(session) {
    this._session = session;
    this._contextManager = BrowserContextManager.instance();
    this._targetRegistry = TargetRegistry.instance();
    this._enabled = false;
    this._eventListeners = [];
    this._createdBrowserContextIds = new Set();
  }

  async attachToTarget({targetId}) {
    if (!this._enabled)
      throw new Error('Target domain is not enabled');
    const sessionId = this._session.dispatcher().createSession(targetId, true /* shouldConnect */);
    return {sessionId};
  }

  async createBrowserContext(options) {
    if (!this._enabled)
      throw new Error('Target domain is not enabled');
    const browserContext = this._contextManager.createBrowserContext(options);
    this._createdBrowserContextIds.add(browserContext.browserContextId);
    return {browserContextId: browserContext.browserContextId};
  }

  async removeBrowserContext({browserContextId}) {
    if (!this._enabled)
      throw new Error('Target domain is not enabled');
    this._createdBrowserContextIds.delete(browserContextId);
    this._contextManager.browserContextForId(browserContextId).destroy();
  }

  async getBrowserContexts() {
    const browserContexts = this._contextManager.getBrowserContexts();
    return {browserContextIds: browserContexts.map(bc => bc.browserContextId)};
  }

  async enable() {
    if (this._enabled)
      return;
    this._enabled = true;
    for (const targetInfo of this._targetRegistry.targetInfos())
      this._onTargetCreated(targetInfo);

    this._eventListeners = [
      helper.on(this._targetRegistry, TargetRegistry.Events.TargetCreated, this._onTargetCreated.bind(this)),
      helper.on(this._targetRegistry, TargetRegistry.Events.TargetChanged, this._onTargetChanged.bind(this)),
      helper.on(this._targetRegistry, TargetRegistry.Events.TargetDestroyed, this._onTargetDestroyed.bind(this)),
      helper.on(this._targetRegistry, TargetRegistry.Events.PageTargetReady, this._onPageTargetReady.bind(this)),
    ];
  }

  dispose() {
    helper.removeListeners(this._eventListeners);
    for (const browserContextId of this._createdBrowserContextIds) {
      const browserContext = this._contextManager.browserContextForId(browserContextId);
      if (browserContext.options.removeOnDetach)
        browserContext.destroy();
    }
    this._createdBrowserContextIds.clear();
  }

  _onTargetCreated(targetInfo) {
    this._session.emitEvent('Target.targetCreated', targetInfo);
  }

  _onTargetChanged(targetInfo) {
    this._session.emitEvent('Target.targetInfoChanged', targetInfo);
  }

  _onTargetDestroyed(targetInfo) {
    this._session.emitEvent('Target.targetDestroyed', targetInfo);
  }

  _onPageTargetReady({sessionIds, targetInfo}) {
    if (!this._createdBrowserContextIds.has(targetInfo.browserContextId))
      return;
    const sessionId = this._session.dispatcher().createSession(targetInfo.targetId, false /* shouldConnect */);
    sessionIds.push(sessionId);
  }

  async newPage({browserContextId}) {
    const targetId = await this._targetRegistry.newPage({browserContextId});
    return {targetId};
  }
}

var EXPORTED_SYMBOLS = ['TargetHandler'];
this.TargetHandler = TargetHandler;
