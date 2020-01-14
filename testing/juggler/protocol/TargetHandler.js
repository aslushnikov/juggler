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
  }

  async attachToTarget({targetId}) {
    const sessionId = await this._session.dispatcher().createSession(targetId);
    return {sessionId};
  }

  async createBrowserContext() {
    return {browserContextId: this._contextManager.createBrowserContext()};
  }

  async removeBrowserContext({browserContextId}) {
    this._contextManager.removeBrowserContext(browserContextId);
  }

  async getBrowserContexts() {
    return {browserContextIds: this._contextManager.getBrowserContexts()};
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
    ];
  }

  dispose() {
    helper.removeListeners(this._eventListeners);
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

  async newPage({browserContextId}) {
    const targetId = await this._targetRegistry.newPage({browserContextId});
    return {targetId};
  }
}

var EXPORTED_SYMBOLS = ['TargetHandler'];
this.TargetHandler = TargetHandler;
