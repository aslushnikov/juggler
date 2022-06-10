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

class BrowserFrameTreeManager {
  constructor() {
    this._browserIdToFrameTree = new Map();
    this._eventListeners = [
      helper.addObserver(this._onBrowsingContextAttached.bind(this), 'browsing-context-attached'),
      helper.addObserver(this._onBrowsingContextDiscarded.bind(this), 'browsing-context-discarded'),
      helper.addObserver(this._onNavigationStarted.bind(this), 'juggler-navigation-started'),
      helper.addObserver(this._onNavigationCommitted.bind(this), 'juggler-navigation-committed'),
      helper.addObserver(this._onNavigationAborted.bind(this), 'juggler-navigation-aborted'),
      helper.addObserver(this._onBrowsingContextWillProcessSwitch.bind(this), 'juggler-will-process-switch'),
    ];
  }

  async _onBrowsingContextAttached(browsingContext, topic, why) {
    // Only top-level frames can be replaced.
    if (why === 'replace') {
      const frameTree = this._browserIdToFrameTree.get(browsingContext.browserId);
      frameTree._mainFrame._setBrowsingContext(browsingContext);
    } else if (why === 'attach') {
      let frameTree = this._browserIdToFrameTree.get(browsingContext.browserId);
      if (!frameTree) {
        frameTree = new BrowserFrameTree(browsingContext);
        this._browserIdToFrameTree.set(browsingContext.browserId, frameTree);
      } else {
        frameTree._attachBrowsingContext(browsingContext);
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
    const frameTree = this._browserIdToFrameTree.get(browsingContext.browserId);
    const browserFrame = frameTree?.browsingContextToFrame(browsingContext);
    // When the main frame is detached, then the whole page is closed.
    if (browserFrame === frameTree.mainFrame()) {
      frameTree.dispose();
      this._browserIdToFrameTree.delete(browsingContext.browserId);
    } else if (browserFrame) {
      browserFrame._detach();
    }
  }

  async _onNavigationStarted(browsingContext, topic, channelId) {
    const frameTree = this._browserIdToFrameTree.get(browsingContext.browserId);
    const frame = frameTree?.browsingContextToFrame(browsingContext);
    if (!frame)
      return;
    frame._pendingNavigationId = channelId;
    frameTree.emit(BrowserFrameTree.Events.NavigationStarted, {
      frameId: frame.frameId(),
      navigationId: channelId,
    });
  }

  async _onNavigationCommitted(browsingContext, topic, url) {
    const frameTree = this._browserIdToFrameTree.get(browsingContext.browserId);
    const frame = frameTree?.browsingContextToFrame(browsingContext);
    if (!frame || !frame._pendingNavigationId)
      return;

    //TODO: are we fine with this async hop to the renderer?
    const name = await frame._channel.connect('').send('getFrameName');
    const navigationId = frame._pendingNavigationId;
    frame._pendingNavigationId = null;
    frameTree.emit(BrowserFrameTree.Events.NavigationCommitted, {
      frameId: frame.frameId(),
      navigationId,
      url,
      name,
    });
  }

  async _onNavigationAborted(browsingContext, topic, errorCode) {
    const frameTree = this._browserIdToFrameTree.get(browsingContext.browserId);
    const frame = frameTree?.browsingContextToFrame(browsingContext);
    if (!frame || !frame._pendingNavigationId)
      return;
    const navigationId = frame._pendingNavigationId;
    frame._pendingNavigationId = null;
    frameTree.emit(BrowserFrameTree.Events.NavigationAborted, {
      frameId: frame.frameId(),
      navigationId,
      errorText: helper.getNetworkErrorStatusText(parseInt(errorCode)),
    });
  }

  async _onBrowsingContextWillProcessSwitch(browsingContext) {
    const frameTree = this._browserIdToFrameTree.get(browsingContext.browserId);
    const frame = frameTree?.browsingContextToFrame(browsingContext);
    if (frame)
      frame._setWindowActor(null);
  }
}

const gManager = new BrowserFrameTreeManager();

// This is a frame tree for a single page.
class BrowserFrameTree {
  static fromBrowsingContext(browsingContext) {
    return gManager._browserIdToFrameTree.get(browsingContext.browserId);
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

    // Settings that are stored in a shared memory.
    this._crossProcessCookie = {
      initScripts: [],
      interceptFileChooserDialog: [],
      bindings: new Map(),
    };
    this._initScripts = [];
  }

  async setInitScripts(initScripts) {
    this._crossProcessCookie.initScripts = initScripts;
    this._updateCrossProcessCookie();
  }

  async addBinding({ name, script, worldName }) {
    this._crossProcessCookie.bindings.set(name, { script, worldName });
    this._updateCrossProcessCookie();

    // Fan out to all existing frames.
    await Promise.all(this.allFrames().map(async frame => {
      await frame._channel.connect('page').send('addBinding', { name, script, worldName });
    }));
  }

  async awaitViewportDimensions({width, height, deviceSizeIsPageSize }) {
    await this._mainFrame._channel.connect('').send('awaitViewportDimensions', {
      width,
      height,
      deviceSizeIsPageSize,
    });
  }

  async hasFailedToOverrideTimezone() {
    return await this._mainFrame._channel.connect('').send('hasFailedToOverrideTimezone').catch(e => true);
  }

  async onBrowserContextSettingChanged(settingName, settingValue) {
    // Fan out to all existing frames.
    await Promise.all(this.allFrames().map(async frame => {
      await frame._channel.connect('').send('applyContextSetting', { name: settingName, value: settingValue }).catch(e => void e);
    }));
  }

  async setInterceptFileChooserDialog(enabled) {
    // Set this as cookie so that all new iframes get this setting.
    this._crossProcessCookie.interceptFileChooserDialog = enabled;
    this._updateCrossProcessCookie();
    // Fan out to all existing frames.
    await Promise.all(this.allFrames().map(async frame => {
      await frame._channel.connect('page').send('setInterceptFileChooserDialog', { enabled });
    }));
  }

  async dispatchKeyEvent(options) {
    //TODO: this does not work with OOPIF
    return await this._mainFrame._channel.connect('page').send('dispatchKeyEvent', options);
  }

  async dispatchTouchEvent(options) {
    //TODO: this does not work with OOPIF
    return await this._mainFrame._channel.connect('page').send('dispatchTouchEvent', options);
  }

  async dispatchTapEvent(options) {
    //TODO: this does not work with OOPIF
    return await this._mainFrame._channel.connect('page').send('dispatchTapEvent', options);
  }

  async dispatchMouseEvent(options) {
    //TODO: this does not work with OOPIF
    return await this._mainFrame._channel.connect('page').send('dispatchMouseEvent', options);
  }

  async dispatchWheelEvent(options) {
    //TODO: this does not work with OOPIF
    return await this._mainFrame._channel.connect('page').send('dispatchWheelEvent', options);
  }

  async insertText(options) {
    //TODO: this does not work with OOPIF
    return await this._mainFrame._channel.connect('page').send('insertText', options);
  }

  async getFullAXTree({ objectId }) {
    //TODO: this does not work with OOPIF
    return await this._mainFrame._channel.connect('page').send('getFullAXTree', {
      objectId,
    });
  }

  async forceRendererCrash() {
    await this._mainFrame._channel.connect('page').send('crash', {});
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
    const [frameId, rendererExecutionContextId] = fromPageLevelUniqueId(options.executionContextId);
    const frame = this._frameIdToFrame.get(frameId);
    if (!frame)
      throw new Error('Failed to find execution context id ' + options.executionContextId);
    return {
      frame,
      options: {
        ...options,
        executionContextId: rendererExecutionContextId,
      }
    };
  }

  async adoptNode(opts) {
    const { frame, options } = this._parseRuntimeCommandOptions(opts);
    if (frame.frameId() !== opts.frameId)
      throw new Error(`ERROR: failed to find execution context "${executionContextId}" in frame "${this._frameId}"`);
    return await frame._channel.connect('page').send('adoptNode', {
      ...options,
      frameId: frame._rendererFrameId,
    });
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

  async screenshot(options) {
    return await this._mainFrame._channel.connect('page').send('screenshot', options);
  }


  allFrames() {
    return [...this._frameIdToFrame.values()];
  }

  dispose() {
    this._mainFrame._detach();
  }

  browsingContextToFrame(browsingContext) {
    return this._browsingContextToBrowserFrame.get(browsingContext);
  }

  frameIdToFrame(frameId) {
    return this._frameIdToFrame.get(frameId);
  }

  frameIdToFrameOrDie(frameId) {
    const frame = this._frameIdToFrame.get(frameId);
    if (!frame)
      throw new Error(`Failed to find frame with id ${frameId}`);
    return frame;
  }

  _attachBrowsingContext(browsingContext) {
    // Frame will register itself in our maps.
    const frame = new BrowserFrame(this, 'frame-' + (++this._lastFrameId), browsingContext);
    return frame;
  }

  _updateCrossProcessCookie() {
    Services.ppmm.sharedData.set('juggler:frametree-cookie-' + this._browserId, this._crossProcessCookie);
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
  static fromBrowsingContext(browsingContext) {
    const frameTree = gManager._browserIdToFrameTree.get(browsingContext.browserId);
    return frameTree._browsingContextToBrowserFrame.get(browsingContext);
  }

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
    this._workers = new Map();

    this._channel = new SimpleChannel('channel-' + frameId);
    const emitEvent = eventName => (...args) => this._frameTree.emit(eventName, ...args);
    const emitEventWithFrameId = eventName => (options) => this._frameTree.emit(eventName, { ...options, frameId: this._frameId });
    const BFTEvents = BrowserFrameTree.Events;
    this._channelListeners = [
      this._channel.register('page', {
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

        pageWorkerCreated: this._onDedicatedWorkerCreated.bind(this),
        pageWorkerDestroyed: this._onDedicatedWorkerDestroyed.bind(this),

        // pageNavigationStarted: this._onNavigationStarted.bind(this),
        // pageNavigationCommitted: this._onNavigationCommitted.bind(this),
        // pageNavigationAborted: this._onNavigationAborted.bind(this),
        pageSameDocumentNavigation: emitEventWithFrameId(BFTEvents.SameDocumentNavigation),

        runtimeConsole: this._onRuntimeConsole.bind(this),
        runtimeExecutionContextCreated: this._onRuntimeExecutionContextCreated.bind(this),
        runtimeExecutionContextDestroyed: this._onRuntimeExecutionContextDestroyed.bind(this),
        pageBindingCalled: this._onBindingCalled.bind(this),

        webSocketCreated: emitEventWithFrameId(BFTEvents.WebSocketCreated),
        webSocketOpened: emitEventWithFrameId(BFTEvents.WebSocketOpened),
        webSocketClosed: emitEventWithFrameId(BFTEvents.WebSocketClosed),
        webSocketFrameReceived: emitEventWithFrameId(BFTEvents.WebSocketFrameReceived),
        webSocketFrameSent: emitEventWithFrameId(BFTEvents.WebSocketFrameSent),
      }),
    ];

    this._frameTree.emit(BFTEvents.FrameAttached, this);
  }

  async setFileInputFiles(options) {
    return await this._channel.connect('page').send('setFileInputFiles', {
      ...options,
      frameId: this._rendererFrameId,
    });
  }

  async getContentQuads(options) {
    return await this._channel.connect('page').send('getContentQuads', {
      ...options,
      frameId: this._rendererFrameId,
    });
  }

  async goBack() {
    return await this._channel.connect('page').send('goBack', {
      frameId: this._rendererFrameId,
    });
  }

  async goForward() {
    return await this._channel.connect('page').send('goForward', {
      frameId: this._rendererFrameId,
    });
  }

  async reload() {
    return await this._channel.connect('page').send('reload', {
      frameId: this._rendererFrameId,
    });
  }

  async describeNode(objectId) {
    return await this._channel.connect('page').send('describeNode', {
      frameId: this._rendererFrameId,
      objectId,
    });
  }

  async scrollIntoViewIfNeeded(objectId, rect) {
    return await this._channel.connect('page').send('scrollIntoViewIfNeeded', {
      frameId: this._rendererFrameId,
      objectId,
      rect,
    });
  }

  async sendMessageToWorker(workerId, methodName, params) {
    const worker = this._workers.get(workerId);
    if (!worker)
      throw new Error(`Failed to find worker with id "${workerId}"`);
    return await worker.sendMessageToWorker(methodName, params);
  }

  _setWindowActor(actor) {
    // All old execution contexts must be destroyed.
    for (const executionContextId of this._executionContextIds)
      this._onRuntimeExecutionContextDestroyed({ executionContextId });
    // All workers must be destroyed as well.
    for (const workerId of this._workers.keys())
      this._onDedicatedWorkerDestroyed({ workerId });

    if (actor)
      this._channel.bindToActor(actor);
    else
      this._channel.resetTransport();
  }

  _onDedicatedWorkerCreated({ frameId, url, workerId }) {
    const worker = new DedicatedWorker(this._frameTree, this._channel, workerId);
    this._workers.set(workerId, worker);
    this._frameTree.emit(BrowserFrameTree.Events.WorkerCreated, {
      frameId: this._frameId,
      url,
      workerId,
    });
  }

  _onDedicatedWorkerDestroyed({ workerId }) {
    const worker = this._workers.get(workerId);
    if (!worker)
      return;
    this._workers.delete(workerId);
    worker.dispose();
    this._frameTree.emit(BrowserFrameTree.Events.WorkerDestroyed, { workerId });
  }

  _onRuntimeConsole(options) {
    const consoleMessageHash = hashConsoleMessage(options);
    for (const worker of this._workers.values()) {
      if (worker._workerConsoleMessages.has(consoleMessageHash)) {
        worker._workerConsoleMessages.delete(consoleMessageHash);
        return;
      }
    }
    this._frameTree.emit(BrowserFrameTree.Events.Console, {
      ...options,
      executionContextId: toPageLevelUniqueId(this.frameId(), options.executionContextId),
    });
  }

  _onRuntimeExecutionContextCreated({ executionContextId, auxData }) {
    this._executionContextIds.add(executionContextId);
    auxData.frameId = this.frameId();
    this._frameTree.emit(BrowserFrameTree.Events.ExecutionContextCreated, {
      executionContextId: toPageLevelUniqueId(this.frameId(), executionContextId),
      auxData
    });
  }

  _onRuntimeExecutionContextDestroyed({ executionContextId }) {
    this._executionContextIds.delete(executionContextId);
    this._frameTree.emit(BrowserFrameTree.Events.ExecutionContextDestroyed, {
      executionContextId: toPageLevelUniqueId(this.frameId(), executionContextId),
    });
  }

  _onBindingCalled({ executionContextId, name, payload }) {
    this._frameTree.emit(BrowserFrameTree.Events.BindingCalled, {
      executionContextId: toPageLevelUniqueId(this.frameId(), executionContextId),
      name,
      payload,
    });
  }

  async navigate(options) {
    return await this._channel.connect('page').send('navigate', {
      ...options,
      frameId: this._rendererFrameId,
    });
  }

  // This might happen due to cross-process navigation.
  _setBrowsingContext(browsingContext) {
    // Tear down navigation listeners and global maps.
    if (this._browsingContext) {
      this._frameTree._browsingContextToBrowserFrame.delete(this._browsingContext);
    }

    // Update browsing context.
    this._browsingContext = browsingContext;

    // Local frame id might change as Cross-Group navigations happen.
    // We never report it over the protocol, but it is used inside the content process.
    //
    // TODO: in future, all renderer code should not use frameId's at all!!!
    // Using rendererFrameId might damage message re-sending as a new renderer attaches.
    this._rendererFrameId = helper.browsingContextToFrameId(browsingContext);

    this._frameTree._browsingContextToBrowserFrame.set(this._browsingContext, this);
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

class DedicatedWorker {
  constructor(frameTree, frameChannel, workerId) {
    this._frameTree = frameTree;
    this._contentWorker = frameChannel.connect(workerId);
    this._workerConsoleMessages = new Set();
    this._workerId = workerId;

    const emitWorkerEvent = eventName => (...args) => this._frameTree.emit(eventName, workerId, ...args);
    this._eventListeners = [
      frameChannel.register(workerId, {
        runtimeConsole: (params) => {
          this._workerConsoleMessages.add(hashConsoleMessage(params));
          this._frameTree.emit(BrowserFrameTree.Events.WorkerConsole, workerId, params);
        },
        runtimeExecutionContextCreated: params => {
          emitWorkerEvent(BrowserFrameTree.WorkerExecutionContextCreated)(params);
        },
        runtimeExecutionContextDestroyed: emitWorkerEvent(BrowserFrameTree.WorkerExecutionContextDestroyed),
      }),
    ];
  }

  async sendMessageToWorker(methodName, params) {
    const [domain] = methodName.split('.');
    if (domain !== 'Runtime')
      throw new Error('ERROR: can only dispatch to Runtime domain inside worker');
    return await this._contentWorker.send(methodName, params);
  }

  dispose() {
    this._contentWorker.dispose();
    helper.removeListeners(this._eventListeners);
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
  WorkerDestroyed: 'workerdestroyed',
  WorkerExecutionContextCreated: 'workerexecutioncontextcreated',
  WorkerExecutionContextDestroyed: 'workerexecutioncontextdestroyed',
  WorkerConsole: 'workerconsole',

  Console: 'console',
  ExecutionContextCreated: 'executioncontextcreated',
  ExecutionContextDestroyed: 'executioncontextdestroyed',
  WebSocketCreated: 'websocketcreated',
  WebSocketOpened: 'websocketopened',
  WebSocketClosed: 'websocketclosed',
  WebSocketFrameReceived: 'websocketframereceived',
  WebSocketFrameSent: 'websocketframesent',
};

function toPageLevelUniqueId(frameId, rendererId) {
  return frameId + '===' + rendererId;
}

function fromPageLevelUniqueId(pageUniqueId) {
  return pageUniqueId.split('===');
}

var EXPORTED_SYMBOLS = ['BrowserFrameTree', 'BrowserFrame'];
this.BrowserFrameTree = BrowserFrameTree;
this.BrowserFrame = BrowserFrame;

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

function hashConsoleMessage(params) {
  return params.location.lineNumber + ':' + params.location.columnNumber + ':' + params.location.url;
}

function channelId(channel) {
  if (channel instanceof Ci.nsIIdentChannel) {
    const identChannel = channel.QueryInterface(Ci.nsIIdentChannel);
    return String(identChannel.channelId);
  }
  return helper.generateId();
}
