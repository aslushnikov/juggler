const { Helper } = ChromeUtils.import('chrome://juggler/content/Helper.js');
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { TabManager } = ChromeUtils.import('chrome://remote/content/shared/TabManager.jsm');
const { ActorManagerParent } = ChromeUtils.import('resource://gre/modules/ActorManagerParent.jsm');
const { SimpleChannel } = ChromeUtils.import('chrome://juggler/content/SimpleChannel.js');
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
    this._lastFrameId = 0;
    this._browsingContextToBrowserFrame = new Map();
    this._frameIdToFrame = new Map();

    for (const browsingContext of collectAllBrowsingContexts(rootBrowsingContext)) {
      const frame = this._attachBrowsingContext(browsingContext);
      if (browsingContext === rootBrowsingContext)
        this._mainFrame = frame;
    }

    this._initScripts = [];

    // We want to receive observer notifications only about this subtree.
    const filterBC = (callback) => {
      return (browsingContext, topic, data) => {
        // Only track browsing contexts from our frame tree.
        if (browsingContext.browserId !== this._browserId)
          return;
        callback(browsingContext, topic, data);
      }
    };
    this._eventListeners = [
      helper.addObserver(filterBC(this._onNavigationStarted.bind(this)), 'juggler-navigation-started'),
      helper.addObserver(filterBC(this._onNavigationCommitted.bind(this)), 'juggler-navigation-committed'),
      helper.addObserver(filterBC(this._onNavigationAborted.bind(this)), 'juggler-navigation-aborted'),
      helper.addObserver(filterBC(this._onBrowsingContextAttached.bind(this)), 'browsing-context-attached'),
      helper.addObserver(filterBC(this._onBrowsingContextDiscarded.bind(this)), 'browsing-context-discarded'),
      helper.addObserver(filterBC(this._onBrowsingContextWillProcessSwitch.bind(this)), 'juggler-will-process-switch'),
    ];
  }


  async setInitScripts(initScripts) {
    this._initScripts = initScripts;
    this._updateCrossProcessCookie();
  }

  mainFrame() {
    return this._mainFrame;
  }

  async ensurePermissions() {
    await Promise.all(this.allFrames().map(async frame => {
      await frame._channel.connect('').send('ensurePermissions', {}).catch(e => void e);
    }));
  }

  _parseRuntimeCommandOptions(options) {
    const [frameId, executionContextId] = fromPersistentExecutionContext(options.executionContextId);
    const frame = this._frameIdToFrame.get(frameId);
    if (!frame)
      throw new Error('Failed to find execution context id ' + options.executionContextId);
    return {
      frame,
      options: {
        ...options,
        executionContextId,
      }
    };
  }

  async evaluate(opts) {
    const { frame, options } = this._parseRuntimeCommandOptions(opts);
    return await frame._channel.connect('page').send('evaluate', options);
  }

  async callFunction(opts) {
    const { frame, options } = this._parseRuntimeCommandOptions(opts);
    return await frame._channel.connect('page').send('callFunction', options);
  }

  async getObjectProperties(opts) {
    const { frame, options } = this._parseRuntimeCommandOptions(opts);
    return await frame._channel.connect('page').send('getObjectProperties', options);
  }

  async disposeObject(opts) {
    const { frame, options } = this._parseRuntimeCommandOptions(opts);
    return await frame._channel.connect('page').send('disposeObject', options);
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

  _attachBrowsingContext(browsingContext) {
    // Frame will register itself in our maps.
    const frame = new BrowserFrame(this, 'frame-' + (++this._lastFrameId), browsingContext);
    this._updateCrossProcessCookie();
    return frame;
  }

  async _onNavigationStarted(browsingContext, topic, channelId) {
    const frame = this._browsingContextToBrowserFrame.get(browsingContext);
    if (!frame)
      return;
    frame._pendingNavigationId = channelId;
    this.emit(BrowserFrameTree.Events.NavigationStarted, {
      frameId: frame.frameId(),
      navigationId: channelId,
    });
  }

  async _onNavigationCommitted(browsingContext, topic, url) {
    const frame = this._browsingContextToBrowserFrame.get(browsingContext);
    if (!frame || !frame._pendingNavigationId)
      return;
    const navigationId = frame._pendingNavigationId;
    frame._pendingNavigationId = null;
    this.emit(BrowserFrameTree.Events.NavigationCommitted, {
      frameId: frame.frameId(),
      navigationId,
      url,
      name: '',
    });
  }

  async _onNavigationAborted(browsingContext, topic, errorCode) {
    const frame = this._browsingContextToBrowserFrame.get(browsingContext);
    if (!frame || !frame._pendingNavigationId)
      return;
    const navigationId = frame._pendingNavigationId;
    frame._pendingNavigationId = null;
    this.emit(BrowserFrameTree.Events.NavigationCommitted, {
      frameId: frame.frameId(),
      navigationId,
      errorText: helper.getNetworkErrorStatusText(errorCode),
    });
  }

  async _onBrowsingContextAttached(browsingContext, topic, why) {
    // Only top-level frames can be replaced.
    if (why === 'replace') {
      this._mainFrame._setBrowsingContext(browsingContext);
    } else if (why === 'attach') {
      this._attachBrowsingContext(browsingContext);
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
    if (browserFrame) {
      browserFrame._detach();
      this._updateCrossProcessCookie();
    }
  }

  async _onBrowsingContextWillProcessSwitch(browsingContext) {
    const browserFrame = this._browsingContextToBrowserFrame.get(browsingContext);
    if (browserFrame)
      browserFrame._setWindowActor(null);
  }

  _updateCrossProcessCookie() {
    const browsingContextIdToFrameId = new Map(
        [...this._browsingContextToBrowserFrame].map(([browsingContext, frame]) => [ browsingContext.id, frame.frameId() ])
    );
    Services.ppmm.sharedData.set('juggler:frametree-cookie-' + this._browserId, {
      browsingContextIdToFrameId,
      initScripts: this._initScripts,
    });
    Services.ppmm.sharedData.flush();
  }

}

// `BrowserFrame` has a 1:1 relationship to `BrowsingContext`.
//
// `BrowsingContext` represents a frame on the webpage. `BrowsingContext` instances
// can come and go, e.g. when frames attach and detach. They are also re-created for a cross-group navigation.
//
// To support the cross-group navigation case, `BrowserFrame` instance can re-bind to a new browsing context instance
// via the `_setBrowsingContext()` method.
class BrowserFrame {
  constructor(frameTree, frameId, browsingContext) {
    this._frameTree = frameTree;
    this._frameId = frameId;
    this._parent = null;
    this._browserId = browsingContext.browserId;
    this._children = new Set();
    this._browsingContext = null;

    // This is assigned from BrowserFrameTree.
    this._pendingNavigationId = null;

    if (browsingContext.parent) {
      const parentFrame = this._frameTree.browsingContextToFrame(browsingContext.parent);
      this._parent = parentFrame;
      this._parent._children.add(this);
    }
    this._frameTree._frameIdToFrame.set(frameId, this);

    this._setBrowsingContext(browsingContext);

    this._executionContextIds = new Set();

    this._channel = new SimpleChannel('channel-' + frameId);
    const emitEvent = eventName => (...args) => this._frameTree.emit(eventName, ...args);
    const emitEventWithFrameId = eventName => (options) => this._frameTree.emit(eventName, { ...options, frameId: this._frameId });
    const BFTEvents = BrowserFrameTree.Events;
    this._channelListeners = [
      this._channel.register('page', {
        pageBindingCalled: emitEvent(BFTEvents.BindingCalled),
        pageDispatchMessageFromWorker: emitEvent(BFTEvents.MessageFromWorker),
        pageEventFired: emitEventWithFrameId(BFTEvents.EventFired),
        pageFileChooserOpened: emitEvent(BFTEvents.FileChooserOpened),
        pageLinkClicked: emitEvent(BFTEvents.LinkClicked),
        pageWillOpenNewWindowAsynchronously: emitEvent(BFTEvents.WillOpenNewWindowAsynchronously),
        pageReady: () => {
          if (!this._parent)
            this._frameTree.emit(BFTEvents.Ready);
        },
        pageUncaughtError: emitEventWithFrameId(BFTEvents.UncaughtError),
        pageWorkerCreated: emitEventWithFrameId(BFTEvents.WorkerCreated),
        pageWorkerDestroyed: emitEvent(BFTEvents.WorkerDesotryed),

        // pageNavigationStarted: this._onNavigationStarted.bind(this),
        // pageNavigationCommitted: this._onNavigationCommitted.bind(this),
        // pageNavigationAborted: this._onNavigationAborted.bind(this),
        pageSameDocumentNavigation: emitEventWithFrameId(BFTEvents.SameDocumentNavigation),

        runtimeConsole: this._onRuntimeConsole.bind(this),
        runtimeExecutionContextCreated: this._onRuntimeExecutionContextCreated.bind(this),
        runtimeExecutionContextDestroyed: this._onRuntimeExecutionContextDestroyed.bind(this),

        webSocketCreated: emitEventWithFrameId(BFTEvents.WebSocketCreated),
        webSocketOpened: emitEventWithFrameId(BFTEvents.WebSocketOpened),
        webSocketClosed: emitEventWithFrameId(BFTEvents.WebSocketClosed),
        webSocketFrameReceived: emitEventWithFrameId(BFTEvents.WebSocketFrameReceived),
        webSocketFrameSent: emitEventWithFrameId(BFTEvents.WebSocketFrameSent),
      }),
    ];

    this._frameTree.emit(BFTEvents.FrameAttached, this);
  }

  _setWindowActor(actor) {
    // All old execution contexts must be destroyed.
    for (const executionContextId of this._executionContextIds)
      this._onRuntimeExecutionContextDestroyed({ executionContextId });

    if (actor)
      this._channel.bindToActor(actor);
    else
      this._channel.resetTransport();
  }

  _onRuntimeConsole(options) {
    this._frameTree.emit(BrowserFrameTree.Events.Console, {
      ...options,
      executionContextId: toPersistentExecutionContext(this.frameId(), options.executionContextId),
    });
  }

  _onRuntimeExecutionContextCreated({ executionContextId, auxData }) {
    this._executionContextIds.add(executionContextId);
    auxData.frameId = this.frameId();
    this._frameTree.emit(BrowserFrameTree.Events.ExecutionContextCreated, {
      executionContextId: toPersistentExecutionContext(this.frameId(), executionContextId),
      auxData
    });
  }

  _onRuntimeExecutionContextDestroyed({ executionContextId }) {
    this._executionContextIds.delete(executionContextId);
    this._frameTree.emit(BrowserFrameTree.Events.ExecutionContextDestroyed, {
      executionContextId: toPersistentExecutionContext(this.frameId(), executionContextId),
    });
  }

  async navigate(options) {
    options.frameId = helper.browsingContextToFrameId(this._browsingContext);
    return await this._channel.connect('page').send('navigate', options);
  }

  // This might happen due to cross-process navigation.
  _setBrowsingContext(browsingContext) {
    // Tear down navigation listeners and global maps.
    if (this._browsingContext) {
      this._frameTree._browsingContextToBrowserFrame.delete(this._browsingContext);
    }

    // Update browsing context.
    this._browsingContext = browsingContext;
    this._frameTree._browsingContextToBrowserFrame.set(this._browsingContext, this);
    this._frameTree._updateCrossProcessCookie();
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
    helper.removeListeners(this._channelListeners);
    this._channel.dispose();
  }
}

BrowserFrameTree.Events = {
  FrameAttached: 'frameattached',
  FrameDetached: 'framedetached',
  NavigationStarted: 'navigationstarted',
  NavigationCommitted: 'navigationcommitted',
  NavigationAborted: 'navigationaborted',
  SameDocumentNavigation: 'samedocumentnavigation',
  BindingCalled: 'bindingcalled',
  MessageFromWorker: 'messagefromworker',
  EventFired: 'eventfired',
  FileChooserOpened: 'filechooseropened',
  LinkClicked: 'linkclicked',
  WillOpenNewWindowAsynchronously: 'willopennewwindowasynchronously',
  Ready: 'ready',
  UncaughtError: 'uncaughterror',
  WorkerCreated: 'workercreated',
  WorkerDesotryed: 'workerdestroyed',
  Console: 'console',
  ExecutionContextCreated: 'executioncontextcreated',
  ExecutionContextDestroyed: 'executioncontextdestroyed',
  WebSocketCreated: 'websocketcreated',
  WebSocketOpened: 'websocketopened',
  WebSocketClosed: 'websocketclosed',
  WebSocketFrameReceived: 'websocketframereceived',
  WebSocketFrameSent: 'websocketframesent',
};

function toPersistentExecutionContext(frameId, executionContextId) {
  return frameId + '===' + executionContextId;
}

function fromPersistentExecutionContext(persistentExecutionContextId) {
  return persistentExecutionContextId.split('===');
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
        DOMContentLoaded: {},
        error: {},
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
