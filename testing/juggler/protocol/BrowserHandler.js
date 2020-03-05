"use strict";

const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { allowAllCerts } = ChromeUtils.import(
  "chrome://marionette/content/cert.js"
);
const {BrowserContextManager} = ChromeUtils.import("chrome://juggler/content/BrowserContextManager.js");

class BrowserHandler {
  /**
   * @param {ChromeSession} session
   */
  constructor() {
    this._sweepingOverride = null;
    this._contextManager = BrowserContextManager.instance();
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

  grantPermissions({browserContextId, origin, permissions}) {
    this._contextManager.browserContextForId(browserContextId).grantPermissions(origin, permissions);
  }

  resetPermissions({browserContextId}) {
    this._contextManager.browserContextForId(browserContextId).resetPermissions();
  }

  setExtraHTTPHeaders({browserContextId, headers}) {
    this._contextManager.browserContextForId(browserContextId).options.extraHTTPHeaders = headers;
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

  dispose() { }
}

var EXPORTED_SYMBOLS = ['BrowserHandler'];
this.BrowserHandler = BrowserHandler;
