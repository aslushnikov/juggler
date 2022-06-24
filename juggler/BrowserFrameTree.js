const { Helper } = ChromeUtils.import('chrome://juggler/content/Helper.js');
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { TabManager } = ChromeUtils.import('chrome://remote/content/shared/TabManager.jsm');
const { ActorManagerParent } = ChromeUtils.import('resource://gre/modules/ActorManagerParent.jsm');
const { SimpleChannel } = ChromeUtils.import('chrome://juggler/content/SimpleChannel.js');
const { EventEmitter } = ChromeUtils.import('resource://gre/modules/EventEmitter.jsm');
const { NetUtil } = ChromeUtils.import('resource://gre/modules/NetUtil.jsm');

const Ci = Components.interfaces;
const Cu = Components.utils;

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
      this._observeBC(this._onBrowsingContextAttached.bind(this), 'browsing-context-attached'),
      this._observeBC(this._onBrowsingContextDiscarded.bind(this), 'browsing-context-discarded'),
      this._observeBC(this._onNavigationStarted.bind(this), 'juggler-navigation-started'),
      this._observeBC(this._onNavigationCommitted.bind(this), 'juggler-navigation-committed'),
      this._observeBC(this._onNavigationAborted.bind(this), 'juggler-navigation-aborted'),
      this._observeBC(this._onBrowsingContextWillProcessSwitch.bind(this), 'juggler-will-process-switch'),
    ];
  }

  frameTrees() {
    return [...this._browserIdToFrameTree.values()];
  }

  // Filter out some suspicious browing contexts we are not interested in.
  _observeBC(callback, topic) {
    return helper.addObserver((browsingContext, ...args) => {
      // We do not want to attach to any chrome-level browsing contexts.
      if (!browsingContext.isContent)
        return;
      if (browsingContext.currentURI.spec.startsWith('moz-extension://'))
        return;
      callback(browsingContext, ...args);
    }, topic);
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
    if (!browserFrame)
      return;

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
      interceptFileChooserDialog: false,
      bindings: new Map(),
    };
    this._initScripts = [];
  }

  async setInitScripts(initScripts) {
    this._crossProcessCookie.initScripts = initScripts;
    this._updateCrossProcessCookie();

    // Fan out to all existing frames.
    await Promise.all(this.allFrames().map(async frame => {
      await frame._channel.connect('').send('setInitScripts', initScripts);
    }));
  }

  async addBinding({ name, script, worldName }) {
    this._crossProcessCookie.bindings.set(name, { name, script, worldName });
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

  async dispatchKeyEvent({ type, keyCode, code, key, repeat, location, text }) {
    const win = this._mainFrame.getWindow();
    if (!this._mainFrame._tip) {
      this._mainFrame._tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
      this._mainFrame._tip.beginInputTransactionForTests(win);
    }
    const tip = this._mainFrame.textInputProcessor();

    if (key === 'Meta' && Services.appinfo.OS !== 'Darwin')
      key = 'OS';
    else if (key === 'OS' && Services.appinfo.OS === 'Darwin')
      key = 'Meta';
    let keyEvent = new (win.KeyboardEvent)("", {
      key,
      code,
      location,
      repeat,
      keyCode
    });
    if (type === 'keydown') {
      if (text && text !== key) {
        tip.commitCompositionWith(text, keyEvent);
      } else {
        const flags = 0;
        tip.keydown(keyEvent, flags);
      }
    } else if (type === 'keyup') {
      if (text)
        throw new Error(`keyup does not support text option`);
      const flags = 0;
      tip.keyup(keyEvent, flags);
    } else {
      throw new Error(`Unknown type ${type}`);
    }
  }

  async dispatchTouchEvent({ type, touchPoints, modifiers }) {
    const win = this._mainFrame.getWindow();
    const offset = await this._mainFrame._channel.connect('page').send('getDocumentElementOffset');
    const defaultPrevented = win.windowUtils.sendTouchEvent(
      type.toLowerCase(),
      touchPoints.map((point, id) => id),
      touchPoints.map(point => point.x + offset.x),
      touchPoints.map(point => point.y + offset.y),
      touchPoints.map(point => point.radiusX === undefined ? 1.0 : point.radiusX),
      touchPoints.map(point => point.radiusY === undefined ? 1.0 : point.radiusY),
      touchPoints.map(point => point.rotationAngle === undefined ? 0.0 : point.rotationAngle),
      touchPoints.map(point => point.force === undefined ? 1.0 : point.force),
      touchPoints.length,
      modifiers);
    return { defaultPrevented };
  }

  async dispatchTapEvent({ x, y, modifiers }) {
    // Force a layout at the point in question, because touch events
    // do not seem to trigger one like mouse events.
    // TODO: shall we force layout here as well?
    // win.windowUtils.elementFromPoint(
    //   x,
    //   y,
    //   false /* aIgnoreRootScrollFrame */,
    //   true /* aFlushLayout */);

    const { defaultPrevented: startPrevented } = await this.dispatchTouchEvent({
      type: 'touchstart',
      modifiers,
      touchPoints: [{x, y}]
    });
    const { defaultPrevented: endPrevented } = await this.dispatchTouchEvent({
      type: 'touchend',
      modifiers,
      touchPoints: [{x, y}]
    });
    if (startPrevented || endPrevented)
      return;

    const win = this._mainFrame.getWindow();
    const offset = await this._mainFrame._channel.connect('page').send('getDocumentElementOffset');
    x += offset.x;
    y += offset.y;

    const frame = this._frameTree.mainFrame();
    win.windowUtils.sendMouseEvent(
      'mousemove',
      x,
      y,
      0 /*button*/,
      0 /*clickCount*/,
      modifiers,
      false /*aIgnoreRootScrollFrame*/,
      undefined /*pressure*/,
      5 /*inputSource*/,
      undefined /*isDOMEventSynthesized*/,
      false /*isWidgetEventSynthesized*/,
      0 /*buttons*/,
      undefined /*pointerIdentifier*/,
      true /*disablePointerEvent*/);

    win.windowUtils.sendMouseEvent(
      'mousedown',
      x,
      y,
      0 /*button*/,
      1 /*clickCount*/,
      modifiers,
      false /*aIgnoreRootScrollFrame*/,
      undefined /*pressure*/,
      5 /*inputSource*/,
      undefined /*isDOMEventSynthesized*/,
      false /*isWidgetEventSynthesized*/,
      1 /*buttons*/,
      undefined /*pointerIdentifier*/,
      true /*disablePointerEvent*/);

    win.windowUtils.sendMouseEvent(
      'mouseup',
      x,
      y,
      0 /*button*/,
      1 /*clickCount*/,
      modifiers,
      false /*aIgnoreRootScrollFrame*/,
      undefined /*pressure*/,
      5 /*inputSource*/,
      undefined /*isDOMEventSynthesized*/,
      false /*isWidgetEventSynthesized*/,
      0 /*buttons*/,
      undefined /*pointerIdentifier*/,
      true /*disablePointerEvent*/);
  }

  async dispatchMouseEvent({ type, x, y, button, clickCount, modifiers, buttons }) {
    const offset = await this._mainFrame._channel.connect('page').send('getDocumentElementOffset');
    x += offset.x;
    y += offset.y;

    const win = this._mainFrame.getWindow();

    win.windowUtils.sendMouseEvent(
      type,
      x,
      y,
      button,
      clickCount,
      modifiers,
      false /*aIgnoreRootScrollFrame*/,
      undefined /*pressure*/,
      undefined /*inputSource*/,
      undefined /*isDOMEventSynthesized*/,
      undefined /*isWidgetEventSynthesized*/,
      buttons
    );

    if (type === 'mousedown' && button === 2) {
      win.windowUtils.sendMouseEvent(
        'contextmenu',
        x,
        y,
        button,
        clickCount,
        modifiers,
        false /*aIgnoreRootScrollFrame*/,
        undefined /*pressure*/,
        undefined /*inputSource*/,
        undefined /*isDOMEventSynthesized*/,
        undefined /*isWidgetEventSynthesized*/,
        buttons);
    }
  }

  async dispatchWheelEvent({ x, y, button, deltaX, deltaY, deltaZ, modifiers }) {
    const offset = await this._mainFrame._channel.connect('page').send('getDocumentElementOffset');
    x += offset.x;
    y += offset.y;
    const deltaMode = 0; // WheelEvent.DOM_DELTA_PIXEL
    const lineOrPageDeltaX = deltaX > 0 ? Math.floor(deltaX) : Math.ceil(deltaX);
    const lineOrPageDeltaY = deltaY > 0 ? Math.floor(deltaY) : Math.ceil(deltaY);

    const win = this._mainFrame.getWindow();
    win.windowUtils.sendWheelEvent(
      x,
      y,
      deltaX,
      deltaY,
      deltaZ,
      deltaMode,
      modifiers,
      lineOrPageDeltaX,
      lineOrPageDeltaY,
      0 /* options */);
  }

  async insertText({ text }) {
    this._mainFrame.textInputProcessor().commitCompositionWith(text);
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
    const [frameId, rendererExecutionContextId] = fromPageLevelExecutionContextId(options.executionContextId);
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
    const fromFrame = this.frameIdToFrameOrDie(opts.frameId);
    const domReference = await fromFrame._channel.connect('page').send('nodeToDOMReference', {
      frameId: fromFrame._rendererFrameId,
      objectId: opts.objectId,
    });
    const { frame, options } = this._parseRuntimeCommandOptions(opts);
    return await frame._channel.connect('page').send('adoptNode', {
      frameId: frame._rendererFrameId,
      domReference,
      executionContextId: options.executionContextId,
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

  async screenshot({ mimeType, clip, omitDeviceScaleFactor }) {
    let lastError = null;
    for (let i = 0; i < 3; ++i) {
      try {
        // This might occasionally throw if called during navigation.
        // So attempt screenshot at least 3 times.
        return await this._screenshotInternal({ mimeType, clip, omitDeviceScaleFactor });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async _screenshotInternal({ mimeType, clip, omitDeviceScaleFactor }) {
    const windowInfo = await this._mainFrame._channel.connect('page').send('getWindowInfo');
    const rect = clip ?
        new DOMRect(clip.x, clip.y, clip.width, clip.height) :
        new DOMRect(windowInfo.scrollX, windowInfo.scrollY, windowInfo.innerWidth, windowInfo.innerHeight);

    // `win.devicePixelRatio` returns a non-overriden value to priveleged code.
    // See https://bugzilla.mozilla.org/show_bug.cgi?id=1761032
    // See https://phabricator.services.mozilla.com/D141323
    const devicePixelRatio = this._mainFrame._browsingContext.overrideDPPX || windowInfo.devicePixelRatio;
    const scale = omitDeviceScaleFactor ? 1 : devicePixelRatio;
    const canvasWidth = rect.width * scale;
    const canvasHeight = rect.height * scale;

    const MAX_CANVAS_DIMENSIONS = 32767;
    const MAX_CANVAS_AREA = 472907776;
    if (canvasWidth > MAX_CANVAS_DIMENSIONS || canvasHeight > MAX_CANVAS_DIMENSIONS)
      throw new Error('Cannot take screenshot larger than ' + MAX_CANVAS_DIMENSIONS);
    if (canvasWidth * canvasHeight > MAX_CANVAS_AREA)
      throw new Error('Cannot take screenshot with more than ' + MAX_CANVAS_AREA + ' pixels');

    // The currentWindowGlobal.drawSnapshot might throw
    // NS_ERROR_LOSS_OF_SIGNIFICANT_DATA if called during navigation.
    const snapshot = await this._mainFrame._browsingContext.currentWindowGlobal.drawSnapshot(
      rect,
      scale,
      "rgb(255,255,255)"
    );

    const win = this._mainFrame.getWindow();
    const canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    let ctx = canvas.getContext('2d');
    ctx.drawImage(snapshot, 0, 0);
    snapshot.close();
    const dataURL = canvas.toDataURL(mimeType);
    return { data: dataURL.substring(dataURL.indexOf(',') + 1) };
  }

  async describeNode(frameId, objectId) {
    const frame = this._frameIdToFrame.get(frameId);
    const { contentFrameId, ownerFrameId } = await frame._channel.connect('page').send('describeNode', {
      frameId: frame._rendererFrameId,
      objectId,
    });
    let contentFrame, ownerFrame;

    // We have to search owner & content frames across
    // all frame trees: element might be owned by a popup.
    for (const frameTree of gManager.frameTrees()) {
      for (const frame of frameTree.allFrames()) {
        if (frame._rendererFrameId === contentFrameId)
          contentFrame = frame;
        if (frame._rendererFrameId === ownerFrameId)
          ownerFrame = frame;
      }
    }
    return {
      contentFrameId: contentFrame?.frameId(),
      ownerFrameId: ownerFrame?.frameId(),
    };
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
    // FrameId has to be unique.
    const frameId = `frame-${this._browserId}.${++this._lastFrameId}`;
    // Frame will register itself in our maps.
    const frame = new BrowserFrame(this, frameId, browsingContext);
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
    return frameTree ? frameTree._browsingContextToBrowserFrame.get(browsingContext) : null;
  }

  constructor(frameTree, frameId, browsingContext) {
    this._frameTree = frameTree;
    this._frameId = frameId;
    this._parent = null;
    this._browserId = browsingContext.browserId;
    this._children = new Set();
    this._browsingContext = null;

    this._textInputProcessor = null;

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
        pageFileChooserOpened: this._onFileChooserOpened.bind(this), 
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

  getWindow() {
    return this._browsingContext.embedderElement.ownerGlobal;
  }

  textInputProcessor() {
    if (!this._textInputProcessor) {
      this._textInputProcessor = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
    }
    this._textInputProcessor.beginInputTransactionForTests(this.getWindow());
    return this._textInputProcessor;
  }

  async setFileInputFiles(options) {
    return await this._channel.connect('page').send('setFileInputFiles', {
      ...options,
      frameId: this._rendererFrameId,
    });
  }

  async getContentQuads(options) {
    const offset = await this._frameTree._mainFrame._channel.connect('page').send('getDocumentElementOffset');
    return await this._channel.connect('page').send('getContentQuads', {
      ...options,
      frameId: this._rendererFrameId,
      offsetX: offset.x,
      offsetY: offset.y,
    });
  }

  async goBack() {
    if (!this._browsingContext.embedderElement?.canGoBack)
      return { success: false };
    this._browsingContext.goBack();
    return { success: true };
  }

  async goForward() {
    if (!this._browsingContext.embedderElement?.canGoForward)
      return { success: false };
    this._browsingContext.goForward();
    return { success: true };
  }

  async reload() {
    this._browsingContext.reload(Ci.nsIWebNavigation.LOAD_FLAGS_NONE);
  }

  async scrollIntoViewIfNeeded(objectId, rect) {
    return await this._channel.connect('page').send('scrollIntoViewIfNeeded', {
      frameId: this._rendererFrameId,
      objectId,
      rect,
    });
  }

  async sendMessageToWorker(workerId, message) {
    const worker = this._workers.get(workerId);
    if (!worker)
      throw new Error(`Failed to find worker with id "${workerId}"`);
    return await worker.sendMessageToWorker(message);
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

  _onFileChooserOpened(options) {
    this._frameTree.emit(BrowserFrameTree.Events.FileChooserOpened, {
      ...options,
      executionContextId: toPageLevelExecutionContextId(this.frameId(), options.executionContextId),
    });
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
      executionContextId: toPageLevelExecutionContextId(this.frameId(), options.executionContextId),
    });
  }

  _onRuntimeExecutionContextCreated({ executionContextId, auxData }) {
    this._executionContextIds.add(executionContextId);
    auxData.frameId = this.frameId();
    this._frameTree.emit(BrowserFrameTree.Events.ExecutionContextCreated, {
      executionContextId: toPageLevelExecutionContextId(this.frameId(), executionContextId),
      auxData
    });
  }

  _onRuntimeExecutionContextDestroyed({ executionContextId }) {
    this._executionContextIds.delete(executionContextId);
    this._frameTree.emit(BrowserFrameTree.Events.ExecutionContextDestroyed, {
      executionContextId: toPageLevelExecutionContextId(this.frameId(), executionContextId),
    });
  }

  _onBindingCalled({ executionContextId, name, payload }) {
    this._frameTree.emit(BrowserFrameTree.Events.BindingCalled, {
      executionContextId: toPageLevelExecutionContextId(this.frameId(), executionContextId),
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

  // This might happen due to cross-group navigation.
  _setBrowsingContext(browsingContext) {
    // This has to be re-created for new window.
    this._textInputProcessor = null;
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
        runtimeExecutionContextCreated: emitWorkerEvent(BrowserFrameTree.Events.WorkerExecutionContextCreated),
        runtimeExecutionContextDestroyed: emitWorkerEvent(BrowserFrameTree.Events.WorkerExecutionContextDestroyed),
      }),
    ];
  }

  async sendMessageToWorker(message) {
    const { id, method, params } = JSON.parse(message);
    const [domain, methodName] = method.split('.');
    if (domain !== 'Runtime')
      throw new Error('ERROR: can only dispatch to Runtime domain inside worker');
    const result = await this._contentWorker.send(methodName, params);
    this._frameTree.emit(BrowserFrameTree.Events.MessageFromWorker, {
      workerId: this._workerId,
      message: JSON.stringify({ result, id }),
    });
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

function toPageLevelExecutionContextId(frameId, rendererId) {
  return frameId + ',' + rendererId;
}

function fromPageLevelExecutionContextId(pageUniqueId) {
  return pageUniqueId.split(',');
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
        // Normally, we instantiate an actor when a new window is created.
        DOMWindowCreated: {},
        // However, for same-origin iframes, the navigation from about:blank
        // to the URL will share the same window, so we need to also create
        // an actor for a new document via DOMDocElementInserted.
        DOMDocElementInserted: {},
        // DOMContentLoaded: {},
        // pagehide: { createActor: false, },
        // error: {},
        // pageshow: {},
        // unload: { capture: true, createActor: false },
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
