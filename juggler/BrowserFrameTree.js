const { Helper } = ChromeUtils.import('chrome://juggler/content/Helper.js');
const { TabManager } = ChromeUtils.import('chrome://remote/content/shared/TabManager.jsm');
const { ActorManagerParent } = ChromeUtils.import('resource://gre/modules/ActorManagerParent.jsm');

const Ci = Components.interfaces;
const helper = new Helper();

class BrowserFrameTree {
  static instance() {
    return BrowserFrameTree._instance || null;
  }

  constructor() {
    BrowserFrameTree._instance = this;
    this._browsingContextToBrowserFrame = new Map();
    this._browserIdToRootFrame = new Map();
    this._eventListeners = [
      helper.addObserver(this._onBrowsingContextAttached.bind(this), 'browsing-context-attached'),
      helper.addObserver(this._onBrowsingContextDiscarded.bind(this), 'browsing-context-discarded'),
    ];
  }

  browsingContextToFrame(browsingContext) {
    return this._browsingContextToBrowserFrame.get(browsingContext);
  }

  async _onBrowsingContextAttached(browsingContext, topic, why) {
    // Only top-level frames can be replaced.
    if (why === 'replace') {
      const rootFrame = this._browserIdToRootFrame.get(browsingContext.browserId);
      rootFrame.setBrowsingContext(browsingContext);
    } else if (why === 'attach') {
      // Make sure this browsingContext is owned by a real browser.
      const allBrowsers = new Set(TabManager.browsers);
      if (allBrowsers.has(browsingContext.top.embedderElement)) {
        new BrowserFrame(this, browsingContext);
      }
    } else {
      dump(`
        error: unknown "why" condition in "browsing-context-attached" event - "${why}"
      `);
    }
  }

  async _onBrowsingContextDiscarded(browsingContext, topic, why) {
    // This case should've been handled already in `browsing-context-attached` event.
    if (why === 'replace')
      return;

    const browserFrame = this._browsingContextToBrowserFrame.get(browsingContext);
    if (browserFrame)
      browserFrame.detach();
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
  constructor(frameTree, browsingContext) {
    this._frameTree = frameTree;
    this._id = helper.generateId();
    this._parent = null;
    this._children = new Set();
    this._browsingContext = null;
    this._hasVisitedNonAboutBlankURL = false;

    if (browsingContext.parent) {
      const parentFrame = this._frameTree.browsingContextToFrame(browsingContext.parent);
      if (!parentFrame) {
        dump(`
          ERROR: failed to find BrowserFrame for a related browsingContext.parent!
        `);
      }
      this._parent = parentFrame;
      this._parent._children.add(this);
    } else {
      // Top-level frames might cross-group navigate, so we'll need to store their browserId.
      this._frameTree._browserIdToRootFrame.set(browsingContext.browserId, this);
    }

    dump(`
      --- attached ---
         id: ${this._id}
     parent: ${this._parent?._id}
        uri: ${browsingContext.currentURI.spec}
      ----------------
    `);

    this._browsingContextListeners = [];
    this.setBrowsingContext(browsingContext, true /* isInitial */);
  }

  // This might happen due to cross-process navigation.
  setBrowsingContext(browsingContext, isInitial = false) {
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
        if (flag & Ci.nsIWebProgressListener.STATE_START)
          this._onNavigationStarted(request);
        else if (flag & Ci.nsIWebProgressListener.STATE_STOP && !status)
          this._onNavigationFinished();
        else if (flag & Ci.nsIWebProgressListener.STATE_STOP && status)
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
    // In case of re-binding browsing context, there's already an on-going navigation that we reported.
    if (isInitial && webProgress.isLoadingDocument)
      this._onNavigationStarted(webProgress.documentRequest);
  }

  _onSameDocumentNavigated() {
    dump(`
      --- same document navigated ---
            id: ${this._id}
        to uri: ${this.uri()}
      ----------------
    `);
  }

  _onNavigationStarted(request) {
    let targetURL = '';
    try {
      targetURL = request.QueryInterface(Ci.nsIChannel).originalURI.spec;
    } catch (e) {}

    if (targetURL === 'about:blank' && !this._hasVisitedNonAboutBlankURL)
      return;

    dump(`
      --- navigation started ---
            id: ${this._id}
        to uri: ${targetURL}
      ----------------
    `);
  }

  _onNavigationFinished() {
    if (this.uri() === 'about:blank' && !this._hasVisitedNonAboutBlankURL)
      return;
    if (this.uri() !== 'about:blank')
      this._hasVisitedNonAboutBlankURL = true;

    dump(`
      --- navigated ---
         id: ${this._id}
        uri: ${this.uri()}
      ----------------
    `);
  }

  _onNavigationAborted(status) {
    const errorText = helper.getNetworkErrorStatusText(status);
    dump(`
      --- navigation aborted ---
         id: ${this._id}
        uri: ${this.uri()}
     status: ${errorText}
      ----------------
    `);
  }

  uri() { return this._browsingContext.currentURI.spec; }
  id() { return this._id; }
  parent() { return this._parent; }
  children() { return this._children; }

  detach() {
    for (const child of this._children)
      child.detach();
    if (!this._parent) {
      this._frameTree._browserIdToRootFrame.delete(this._browsingContext.browserId);
    } else {
      // break child-parent relationship.
      this._parent._children.delete(this);
      this._parent = null;
    }
    this._frameTree._browsingContextToBrowserFrame.delete(this._browsingContext);
    dump(`
      ----------------------
      detached: ${this._id}
           uri: ${this.uri()}
    `);
  }
}

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

