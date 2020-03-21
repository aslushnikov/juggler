"use strict";

const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { allowAllCerts } = ChromeUtils.import(
  "chrome://marionette/content/cert.js"
);
const {BrowserContextManager} = ChromeUtils.import("chrome://juggler/content/BrowserContextManager.js");
const {TargetRegistry} = ChromeUtils.import("chrome://juggler/content/TargetRegistry.js");
const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');

const helper = new Helper();

class BrowserHandler {
  /**
   * @param {ChromeSession} session
   */
  constructor(session) {
    this._session = session;
    this._contextManager = BrowserContextManager.instance();
    this._targetRegistry = TargetRegistry.instance();
    this._enabled = false;
    this._attachToDefaultContext = false;
    this._eventListeners = [];
    this._createdBrowserContextIds = new Set();
  }

  async enable({attachToDefaultContext}) {
    if (this._enabled)
      return;
    this._enabled = true;
    this._attachToDefaultContext = attachToDefaultContext;

    for (const target of this._targetRegistry.targets()) {
      if (!this._shouldAttachToTarget(target))
        continue;
      const sessionId = this._session.dispatcher().createSession(target.id(), true /* shouldConnect */);
      this._session.emitEvent('Browser.attachedToTarget', {
        sessionId,
        targetInfo: target.info()
      });
    }

    this._eventListeners = [
      helper.on(this._targetRegistry, TargetRegistry.Events.PageTargetReady, this._onPageTargetReady.bind(this)),
    ];
  }

  async createBrowserContext(options) {
    if (!this._enabled)
      throw new Error('Browser domain is not enabled');
    const browserContext = this._contextManager.createBrowserContext(options);
    this._createdBrowserContextIds.add(browserContext.browserContextId);
    return {browserContextId: browserContext.browserContextId};
  }

  async removeBrowserContext({browserContextId}) {
    if (!this._enabled)
      throw new Error('Browser domain is not enabled');
    this._createdBrowserContextIds.delete(browserContextId);
    this._contextManager.browserContextForId(browserContextId).destroy();
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

  _shouldAttachToTarget(target) {
    if (!target._browserContext)
      return false;
    if (this._createdBrowserContextIds.has(target._browserContext.browserContextId))
      return true;
    return this._attachToDefaultContext && target._browserContext === this._contextManager.defaultContext();
  }

  _onPageTargetReady({sessionIds, target}) {
    if (!this._shouldAttachToTarget(target))
      return;
    const sessionId = this._session.dispatcher().createSession(target.id(), false /* shouldConnect */);
    sessionIds.push(sessionId);
    this._session.emitEvent('Browser.attachedToTarget', {
      sessionId,
      targetInfo: target.info()
    });
  }

  async newPage({browserContextId}) {
    const targetId = await this._targetRegistry.newPage({browserContextId});
    return {targetId};
  }

  async close() {
    let browserWindow = Services.wm.getMostRecentWindow(
      "navigator:browser"
    );
    if (browserWindow && browserWindow.gBrowserInit) {
      await browserWindow.gBrowserInit.idleTasksFinishedPromise;
    }
    Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
  }

  async setIgnoreHTTPSErrors({enabled}) {
    if (!enabled) {
      allowAllCerts.disable()
      Services.prefs.setBoolPref('security.mixed_content.block_active_content', true);
    } else {
      allowAllCerts.enable()
      Services.prefs.setBoolPref('security.mixed_content.block_active_content', false);
    }
  }

  async grantPermissions({browserContextId, origin, permissions}) {
    const browserContext = this._contextManager.browserContextForId(browserContextId);
    browserContext.grantPermissions(origin, permissions);
    const contextPages = this._targetRegistry.pageTargets(browserContextId);
    const promises = [];
    for (const page of contextPages) {
      if (origin === '*' || page._url.startsWith(origin)) {
        browserContext.grantPermissionsToOrigin(page._url);
        promises.push(page.ensurePermissions(permissions));
      }
    }
    await Promise.all(promises);
  }

  resetPermissions({browserContextId}) {
    this._contextManager.browserContextForId(browserContextId).resetPermissions();
  }

  setExtraHTTPHeaders({browserContextId, headers}) {
    this._contextManager.browserContextForId(browserContextId).options.extraHTTPHeaders = headers;
  }

  setHTTPCredentials({browserContextId, credentials}) {
    this._contextManager.browserContextForId(browserContextId).options.httpCredentials = credentials;
  }

  addScriptToEvaluateOnNewDocument({browserContextId, script}) {
    this._contextManager.browserContextForId(browserContextId).addScriptToEvaluateOnNewDocument(script);
  }

  setCookies({browserContextId, cookies}) {
    this._contextManager.browserContextForId(browserContextId).setCookies(cookies);
  }

  clearCookies({browserContextId}) {
    this._contextManager.browserContextForId(browserContextId).clearCookies();
  }

  getCookies({browserContextId}) {
    const cookies = this._contextManager.browserContextForId(browserContextId).getCookies();
    return {cookies};
  }

  async getInfo() {
    const version = Components.classes["@mozilla.org/xre/app-info;1"]
                              .getService(Components.interfaces.nsIXULAppInfo)
                              .version;
    const userAgent = Components.classes["@mozilla.org/network/protocol;1?name=http"]
                                .getService(Components.interfaces.nsIHttpProtocolHandler)
                                .userAgent;
    return {version: 'Firefox/' + version, userAgent};
  }
}

var EXPORTED_SYMBOLS = ['BrowserHandler'];
this.BrowserHandler = BrowserHandler;
