const { Helper } = ChromeUtils.import('chrome://juggler/content/Helper.js');
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { TabManager } = ChromeUtils.import('chrome://remote/content/shared/TabManager.jsm');
const { ActorManagerParent } = ChromeUtils.import('resource://gre/modules/ActorManagerParent.jsm');
const { EventEmitter } = ChromeUtils.import('resource://gre/modules/EventEmitter.jsm');
const { NetUtil } = ChromeUtils.import('resource://gre/modules/NetUtil.jsm');

const Ci = Components.interfaces;
const helper = new Helper();

function collectAllBrowsingContexts(browsingContext, allBrowsingContexts = []) {
  allBrowsingContexts.push(browsingContext);
  for (const child of browsingContext.children)
    collectAllBrowsingContexts(child, allBrowsingContexts);
  return allBrowsingContexts;
}

class BrowserFrameTree {
  static fromRootBrowsingContext(browsingContext) {
    return new BrowserFrameTree(browsingContext);
  }

  constructor(rootBrowsingContext) {
    EventEmitter.decorate(this);
    this._browserId = rootBrowsingContext.browserId;
    this._lastFrameId = 1;
    this._browsingContextToBrowserFrame = new Map();
    this._frameIdToFrame = new Map();

    for (const browsingContext of collectAllBrowsingContexts(rootBrowsingContext)) {
      const frame = this._attachBrowsingContext(browsingContext);
      if (browsingContext === rootBrowsingContext)
        this._mainFrame = frame;
    }

    this._eventListeners = [
      helper.addObserver(this._onBrowsingContextAttached.bind(this), 'browsing-context-attached'),
      helper.addObserver(this._onBrowsingContextDiscarded.bind(this), 'browsing-context-discarded'),
    ];
  }

  allFrames() {
    return [...this._frameIdToFrame.values()];
  }

  dispose() {
    helper.removeListeners(this._eventListeners);
    this._mainFrame._detach();
  }

  browsingContextToFrame(browsingContext) {
    return this._browsingContextToBrowserFrame.get(browsingContext);
  }

  frameIdToFrame(frameId) {
    return this._frameIdToFrame.get(frameId);
  }

  async _onBrowsingContextAttached(browsingContext, topic, why) {
    // Only track browsing contexts from our frame tree.
    if (browsingContext.browserId !== this._browserId)
      return;
    // Only top-level frames can be replaced.
    if (why === 'replace') {
      this._mainFrame.setBrowsingContext(browsingContext);
    } else if (why === 'attach') {
      this._attachBrowsingContext(browsingContext);
    } else {
      dump(`
        error: unknown "why" condition in "browsing-context-attached" event - "${why}"
      `);
    }
  }

  _attachBrowsingContext(browsingContext) {
    // Frame will register itself in our maps.
    return new BrowserFrame(this, 'frame-' + (++this._lastFrameId), browsingContext);
  }

  async _onBrowsingContextDiscarded(browsingContext, topic, why) {
    // This case should've been handled already in `browsing-context-attached` event.
    if (why === 'replace')
      return;

    const browserFrame = this._browsingContextToBrowserFrame.get(browsingContext);
    if (browserFrame)
      browserFrame._detach();
  }
}

// `BrowserFrame` has a 1:1 relationship to `BrowsingContext`.
//
// `BrowsingContext` represents a frame on the webpage. `BrowsingContext` instances
// can come and go, e.g. when frames attach and detach. They are also re-created for a cross-group navigation.
//
// To support the cross-group navigation case, `BrowserFrame` instance can re-bind to a new browsing context instance
// via the `setBrowsingContext()` method.
class BrowserFrame {
  constructor(frameTree, frameId, browsingContext) {
    this._frameTree = frameTree;
    this._frameId = frameId;
    this._parent = null;
    this._browserId = browsingContext.browserId;
    this._children = new Set();
    this._browsingContext = null;

    this._pendingNavigation = null;

    if (browsingContext.parent) {
      const parentFrame = this._frameTree.browsingContextToFrame(browsingContext.parent);
      if (!parentFrame) {
        dump(`
          ERROR: failed to find BrowserFrame for a related browsingContext.parent!
        `);
      }
      this._parent = parentFrame;
      this._parent._children.add(this);
    }
    this._frameTree._frameIdToFrame.set(frameId, this);

    this._browsingContextListeners = [];
    this.setBrowsingContext(browsingContext);

    this._frameTree.emit(BrowserFrameTree.Events.FrameAttached, this);
  }

  async navigate(url, referrer) {
    try {
      NetUtil.newURI(url);
    } catch (e) {
      throw new Error(`Invalid url: "${url}"`);
    }
    let referrerInfo = null;
    if (referrer) {
      try {
        const referrerURI = NetUtil.newURI(referrer);
        const ReferrerInfo = Components.Constructor(
          '@mozilla.org/referrer-info;1',
          'nsIReferrerInfo',
          'init'
        );
        referrerInfo = new ReferrerInfo(Ci.nsIHttpChannel.REFERRER_POLICY_UNSET, true, referrerURI);
      } catch (e) {
        throw new Error(`Invalid referrer: "${referrer}"`);
      }
    }
    this._browsingContext.loadURI(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      flags: Ci.nsIWebNavigation.LOAD_FLAGS_NONE,
      referrerInfo,
      postData: null,
      headers: null,
    });
    await helper.once(this._frameTree, BrowserFrameTree.Events.NavigationStarted, frame => {
      return frame === this;
    });
    dump(`

        kicked out navigation

    `);
    return this._pendingNavigation;
  }

  // This might happen due to cross-process navigation.
  setBrowsingContext(browsingContext) {
    // Tear down navigation listeners and global maps.
    if (this._browsingContext) {
      helper.removeListeners(this._browsingContextListeners);
      this._frameTree._browsingContextToBrowserFrame.delete(this._browsingContext);
    }

    // Update browsing context.
    this._browsingContext = browsingContext;
    this._frameTree._browsingContextToBrowserFrame.set(this._browsingContext, this);

    // Re-bind navigation listener.
    const webProgress = this._browsingContext.webProgress;
    const webProgressListener = {
      QueryInterface: ChromeUtils.generateQI([Ci.nsIWebProgressListener, Ci.nsISupportsWeakReference]),
      onStateChange: (progress, request, flag, status) => {
        if (progress !== webProgress)
          return;
        if (flag & Ci.nsIWebProgressListener.STATE_STOP && status)
          this._onNavigationAborted(status);
      },
      onLocationChange: (progress, request, location, flags) => {
        if (progress !== webProgress)
          return;
        const sameDocumentNavigation = !!(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_HASHCHANGE);
        if (sameDocumentNavigation)
          this._onSameDocumentNavigated();
      }
    };
    this._browsingContextListeners = [
      helper.addProgressListener(webProgress, webProgressListener, Ci.nsIWebProgress.NOTIFY_STATE_ALL | Ci.nsIWebProgress.NOTIFY_LOCATION),
    ];
  }

  _onSameDocumentNavigated() {
    this._frameTree.emit(BrowserFrameTree.Events.SameDocumentNavigation, this);
  }

  _onNavigationStarted({ navigationId, navigationURL }) {
    this._pendingNavigation = {
      navigationId,
      navigationURL,
    };

    this._frameTree.emit(BrowserFrameTree.Events.NavigationStarted, this, this._pendingNavigation);
  }

  _onGlobalWindowCleared() {
    this._onNavigationCommitted();
  }

  _onNavigationCommitted() {
    if (!this._pendingNavigation)
      return;
    const { navigationId } = this._pendingNavigation;
    this._pendingNavigation = null;
    this._frameTree.emit(BrowserFrameTree.Events.NavigationCommitted, this, { navigationId });
  }

  _onNavigationAborted(statusCode) {
    if (!this._pendingNavigation)
      return;
    const errorText = helper.getNetworkErrorStatusText(statusCode);
    const { navigationId } = this._pendingNavigation;
    this._pendingNavigation = null;
    this._frameTree.emit(BrowserFrameTree.Events.NavigationAborted, this, { errorText, navigationId });
  }

  url() { return this._browsingContext.currentURI.spec; }
  frameId() { return this._frameId; }
  browserId() { return this._browserId; }
  parent() { return this._parent || null; }
  children() { return this._children; }
  pendingNavigation() {
    return this._pendingNavigation;
  }

  _detach() {
    for (const child of this._children)
      child._detach();
    if (this._parent) {
      // break child-parent relationship.
      this._parent._children.delete(this);
      this._parent = null;
    }
    this._frameTree._browsingContextToBrowserFrame.delete(this._browsingContext);
    this._frameTree._frameIdToFrame.delete(this._frameId);
    this._frameTree.emit(BrowserFrameTree.Events.FrameDetached, this);
  }
}

BrowserFrameTree.Events = {
  FrameAttached: 'frameattached',
  FrameDetached: 'framedetached',
  NavigationStarted: 'navigationstarted',
  NavigationCommitted: 'navigationcommitted',
  NavigationAborted: 'navigationaborted',
  SameDocumentNavigation: 'samedocumentnavigation',
  // WorkerCreated: 'workercreated',
  // WorkerDestroyed: 'workerdestroyed',
  // WebSocketCreated: 'websocketcreated',
  // WebSocketOpened: 'websocketopened',
  // WebSocketClosed: 'websocketclosed',
  // WebSocketFrameReceived: 'websocketframereceived',
  // WebSocketFrameSent: 'websocketframesent',
  // PageReady: 'pageready',
  // Load: 'load',
};

var EXPORTED_SYMBOLS = ['BrowserFrameTree'];
this.BrowserFrameTree = BrowserFrameTree;

// Register JSWindowActors that will be instantiated for 
// each frame.
ActorManagerParent.addJSWindowActors({
  JugglerFrame: {
    parent: {
      moduleURI: 'chrome://juggler/content/actors/JugglerFrameParent.jsm',
    },
    child: {
      moduleURI: 'chrome://juggler/content/actors/JugglerFrameChild.jsm',
      events: {
        DOMWindowCreated: {},
        DOMDocElementInserted: {},
        pageshow: {},
        pagehide: {},
      },
    },
    allFrames: true,
  },
});

function channelId(channel) {
  if (channel instanceof Ci.nsIIdentChannel) {
    const identChannel = channel.QueryInterface(Ci.nsIIdentChannel);
    return String(identChannel.channelId);
  }
  return helper.generateId();
}
