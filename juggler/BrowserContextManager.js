"use strict";

const {ContextualIdentityService} = ChromeUtils.import("resource://gre/modules/ContextualIdentityService.jsm");
const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");
const {NetUtil} = ChromeUtils.import('resource://gre/modules/NetUtil.jsm');
const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {EventEmitter} = ChromeUtils.import('resource://gre/modules/EventEmitter.jsm');
const helper = new Helper();

const IDENTITY_NAME = 'JUGGLER ';
const HUNDRED_YEARS = 60 * 60 * 24 * 365 * 100;

const ALL_PERMISSIONS = [
  'geo',
  'microphone',
  'camera',
  'desktop-notifications',
];

class BrowserContextManager {
  static instance() {
    return BrowserContextManager._instance || null;
  }

  static initialize() {
    if (BrowserContextManager._instance)
      return;
    BrowserContextManager._instance = new BrowserContextManager();
  }

  constructor() {
    this._browserContextIdToBrowserContext = new Map();
    this._userContextIdToBrowserContext = new Map();

    // Cleanup containers from previous runs (if any)
    for (const identity of ContextualIdentityService.getPublicIdentities()) {
      if (identity.name && identity.name.startsWith(IDENTITY_NAME)) {
        ContextualIdentityService.remove(identity.userContextId);
        ContextualIdentityService.closeContainerTabs(identity.userContextId);
      }
    }

    this._defaultContext = new BrowserContext(this, undefined, undefined);
  }

  defaultContext() {
    return this._defaultContext;
  }

  createBrowserContext(options) {
    return new BrowserContext(this, helper.generateId(), options);
  }

  browserContextForId(browserContextId) {
    return this._browserContextIdToBrowserContext.get(browserContextId);
  }

  browserContextForUserContextId(userContextId) {
    return this._userContextIdToBrowserContext.get(userContextId);
  }

  getBrowserContexts() {
    return Array.from(this._browserContextIdToBrowserContext.values());
  }
}

class BrowserContext {
  constructor(manager, browserContextId, options) {
    EventEmitter.decorate(this);

    this._manager = manager;
    this.browserContextId = browserContextId;
    // Default context has userContextId === 0, but we pass undefined to many APIs just in case.
    this.userContextId = 0;
    if (browserContextId !== undefined) {
      const identity = ContextualIdentityService.create(IDENTITY_NAME + browserContextId);
      this.userContextId = identity.userContextId;
    }
    this._principals = [];
    // Maps origins to the permission lists.
    this._permissions = new Map();
    this._manager._browserContextIdToBrowserContext.set(this.browserContextId, this);
    this._manager._userContextIdToBrowserContext.set(this.userContextId, this);
    this.options = options || {};
    this.options.scriptsToEvaluateOnNewDocument = [];
  }

  destroy() {
    if (this.userContextId !== 0) {
      ContextualIdentityService.remove(this.userContextId);
      ContextualIdentityService.closeContainerTabs(this.userContextId);
    }
    this._manager._browserContextIdToBrowserContext.delete(this.browserContextId);
    this._manager._userContextIdToBrowserContext.delete(this.userContextId);
  }

  addScriptToEvaluateOnNewDocument(script) {
    this.options.scriptsToEvaluateOnNewDocument.push(script);
    this.emit(BrowserContext.Events.ScriptToEvaluateOnNewDocumentAdded, script);
  }

  grantPermissions(origin, permissions) {
    this._permissions.set(origin, permissions);
  }

  resetPermissions() {
    for (const principal of this._principals) {
      for (const permission of ALL_PERMISSIONS)
        Services.perms.removeFromPrincipal(principal, permission);
    }
    this._principals = [];
    this._permissions.clear();
  }

  grantPermissionsToOrigin(url) {
    let origin = Array.from(this._permissions.keys()).find(key => url.startsWith(key));
    if (!origin)
      origin = '*';

    const permissions = this._permissions.get(origin);
    if (!permissions)
      return;

    const attrs = { userContextId: this.userContextId || undefined };
    const principal = Services.scriptSecurityManager.createContentPrincipal(NetUtil.newURI(url), attrs);
    this._principals.push(principal);
    for (const permission of ALL_PERMISSIONS) {
      const action = permissions.includes(permission) ? Ci.nsIPermissionManager.ALLOW_ACTION : Ci.nsIPermissionManager.DENY_ACTION;
      Services.perms.addFromPrincipal(principal, permission, action, Ci.nsIPermissionManager.EXPIRE_NEVER, 0 /* expireTime */);
    }
  }

  setCookies(cookies) {
    const protocolToSameSite = {
      [undefined]: Ci.nsICookie.SAMESITE_NONE,
      'Lax': Ci.nsICookie.SAMESITE_LAX,
      'Strict': Ci.nsICookie.SAMESITE_STRICT,
    };
    for (const cookie of cookies) {
      const uri = cookie.url ? NetUtil.newURI(cookie.url) : null;
      let domain = cookie.domain;
      if (!domain) {
        if (!uri)
          throw new Error('At least one of the url and domain needs to be specified');
        domain = uri.host;
      }
      let path = cookie.path;
      if (!path)
        path = uri ? dirPath(uri.filePath) : '/';
      let secure = false;
      if (cookie.secure !== undefined)
        secure = cookie.secure;
      else if (uri && uri.scheme === 'https')
        secure = true;
      Services.cookies.add(
        domain,
        path,
        cookie.name,
        cookie.value,
        secure,
        cookie.httpOnly || false,
        cookie.expires === undefined || cookie.expires === -1 /* isSession */,
        cookie.expires === undefined ? Date.now() + HUNDRED_YEARS : cookie.expires,
        { userContextId: this.userContextId || undefined } /* originAttributes */,
        protocolToSameSite[cookie.sameSite],
      );
    }
  }

  clearCookies() {
    Services.cookies.removeCookiesWithOriginAttributes(JSON.stringify({ userContextId: this.userContextId || undefined }));
  }

  getCookies() {
    const result = [];
    const sameSiteToProtocol = {
      [Ci.nsICookie.SAMESITE_NONE]: 'None',
      [Ci.nsICookie.SAMESITE_LAX]: 'Lax',
      [Ci.nsICookie.SAMESITE_STRICT]: 'Strict',
    };
    for (let cookie of Services.cookies.cookies) {
      if (cookie.originAttributes.userContextId !== this.userContextId)
        continue;
      if (cookie.host === 'addons.mozilla.org')
        continue;
      result.push({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.host,
        path: cookie.path,
        expires: cookie.isSession ? -1 : cookie.expiry,
        size: cookie.name.length + cookie.value.length,
        httpOnly: cookie.isHttpOnly,
        secure: cookie.isSecure,
        session: cookie.isSession,
        sameSite: sameSiteToProtocol[cookie.sameSite],
      });
    }
    return result;
  }
}

BrowserContext.Events = {
  ScriptToEvaluateOnNewDocumentAdded: Symbol('BrowserContext.Events.ScriptToEvaluateOnNewDocumentAdded'),
};

function dirPath(path) {
  return path.substring(0, path.lastIndexOf('/') + 1);
}

var EXPORTED_SYMBOLS = ['BrowserContextManager', 'BrowserContext'];
this.BrowserContextManager = BrowserContextManager;
this.BrowserContext = BrowserContext;

