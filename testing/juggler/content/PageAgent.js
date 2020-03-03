"use strict";
const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {NetUtil} = ChromeUtils.import('resource://gre/modules/NetUtil.jsm');

const helper = new Helper();

const registeredWorkerListeners = new Map();
const workerListener =  {
  QueryInterface: ChromeUtils.generateQI([Ci.nsIWorkerDebuggerListener]),
  onMessage: (wrapped) => {
    const message = JSON.parse(wrapped);
    const listener = registeredWorkerListeners.get(message.workerId);
    if (listener)
      listener(message);
  },
  onClose: () => {
  },
  onError: (filename, lineno, message) => {
    dump(`Error in worker: ${message} @${filename}:${lineno}\n`);
  },
};

class FrameData {
  constructor(agent, frame) {
    this._agent = agent;
    this._frame = frame;
    this._isolatedWorlds = new Map();
    this._workers = new Map();
    this.reset();
  }

  reset() {
    if (this.mainContext)
      this._agent._runtime.destroyExecutionContext(this.mainContext);
    for (const world of this._isolatedWorlds.values())
      this._agent._runtime.destroyExecutionContext(world);
    this._isolatedWorlds.clear();

    this.mainContext = this._agent._runtime.createExecutionContext(this._frame.domWindow(), this._frame.domWindow(), {
      frameId: this._frame.id(),
      name: '',
    });

    for (const bindingName of this._agent._bindingsToAdd.values())
      this.exposeFunction(bindingName);
    for (const script of this._agent._frameTree.scriptsToEvaluateOnNewDocument()) {
      // TODO: this should actually be handled in FrameTree, but first we have to move
      // execution contexts there.
      try {
        let result = this.mainContext.evaluateScript(script);
        if (result && result.objectId)
          this.mainContext.disposeObject(result.objectId);
      } catch (e) {
      }
    }
    for (const {script, worldName} of this._agent._scriptsToEvaluateOnNewDocument.values()) {
      const context = worldName ? this.createIsolatedWorld(worldName) : this.mainContext;
      try {
        let result = context.evaluateScript(script);
        if (result && result.objectId)
          context.disposeObject(result.objectId);
      } catch (e) {
      }
    }
  }

  exposeFunction(name) {
    Cu.exportFunction((...args) => {
      this._agent._session.emitEvent('Page.bindingCalled', {
        executionContextId: this.mainContext.id(),
        name,
        payload: args[0]
      });
    }, this._frame.domWindow(), {
      defineAs: name,
    });
  }

  createIsolatedWorld(name) {
    const principal = [this._frame.domWindow()]; // extended principal
    const sandbox = Cu.Sandbox(principal, {
      sandboxPrototype: this._frame.domWindow(),
      wantComponents: false,
      wantExportHelpers: false,
      wantXrays: true,
    });
    const world = this._agent._runtime.createExecutionContext(this._frame.domWindow(), sandbox, {
      frameId: this._frame.id(),
      name,
    });
    this._isolatedWorlds.set(world.id(), world);
    return world;
  }

  unsafeObject(objectId) {
    if (this.mainContext) {
      const result = this.mainContext.unsafeObject(objectId);
      if (result)
        return result.object;
    }
    for (const world of this._isolatedWorlds.values()) {
      const result = world.unsafeObject(objectId);
      if (result)
        return result.object;
    }
    throw new Error('Cannot find object with id = ' + objectId);
  }

  workerCreated(workerDebugger) {
    const workerId = helper.generateId();
    this._workers.set(workerId, workerDebugger);
    this._agent._session.emitEvent('Page.workerCreated', {
      workerId,
      frameId: this._frame.id(),
      url: workerDebugger.url,
    });
    // Note: this does not interoperate with firefox devtools.
    if (!workerDebugger.isInitialized) {
      workerDebugger.initialize('chrome://juggler/content/content/WorkerMain.js');
      workerDebugger.addListener(workerListener);
    }
    registeredWorkerListeners.set(workerId, message => {
      if (message.command === 'dispatch') {
        this._agent._session.emitEvent('Page.dispatchMessageFromWorker', {
          workerId,
          message: message.message,
        });
      }
      if (message.command === 'console')
        this._agent._runtime.filterConsoleMessage(message.hash);
    });
    workerDebugger.postMessage(JSON.stringify({command: 'connect', workerId}));
  }

  workerDestroyed(wd) {
    for (const [workerId, workerDebugger] of this._workers) {
      if (workerDebugger === wd) {
        this._agent._session.emitEvent('Page.workerDestroyed', {
          workerId,
        });
        this._workers.delete(workerId);
        registeredWorkerListeners.delete(workerId);
      }
    }
  }

  sendMessageToWorker(workerId, message) {
    const workerDebugger = this._workers.get(workerId);
    if (!workerDebugger)
      throw new Error('Cannot find worker with id "' + workerId + '"');
    workerDebugger.postMessage(JSON.stringify({command: 'dispatch', workerId, message}));
  }

  dispose() {
    for (const [workerId, workerDebugger] of this._workers) {
      workerDebugger.postMessage(JSON.stringify({command: 'disconnect', workerId}));
      registeredWorkerListeners.delete(workerId);
    }
    this._workers.clear();
  }
}

class PageAgent {
  constructor(session, runtimeAgent, frameTree, networkMonitor) {
    this._session = session;
    this._runtime = runtimeAgent;
    this._frameTree = frameTree;
    this._networkMonitor = networkMonitor;

    this._frameData = new Map();
    this._scriptsToEvaluateOnNewDocument = new Map();
    this._bindingsToAdd = new Set();

    this._eventListeners = [];
    this._enabled = false;

    const docShell = frameTree.mainFrame().docShell();
    this._docShell = docShell;
    this._initialDPPX = docShell.contentViewer.overrideDPPX;
    this._customScrollbars = null;

    this._wdm = Cc["@mozilla.org/dom/workers/workerdebuggermanager;1"].createInstance(Ci.nsIWorkerDebuggerManager);
    this._wdmListener = {
      QueryInterface: ChromeUtils.generateQI([Ci.nsIWorkerDebuggerManagerListener]),
      onRegister: this._onWorkerCreated.bind(this),
      onUnregister: this._onWorkerDestroyed.bind(this),
    };

    this._runtime.setOnErrorFromWorker((domWindow, message, stack) => {
      const frame = this._frameTree.frameForDocShell(domWindow.docShell);
      if (!frame)
        return;
      this._session.emitEvent('Page.uncaughtError', {
        frameId: frame.id(),
        message,
        stack,
      });
    });
  }

  async awaitViewportDimensions({width, height}) {
    const win = this._frameTree.mainFrame().domWindow();
    if (win.innerWidth === width && win.innerHeight === height)
      return;
    await new Promise(resolve => {
      const listener = helper.addEventListener(win, 'resize', () => {
        if (win.innerWidth === width && win.innerHeight === height) {
          helper.removeListeners([listener]);
          resolve();
        }
      });
    });
  }

  requestDetails({channelId}) {
    return this._networkMonitor.requestDetails(channelId);
  }

  async setEmulatedMedia({type, colorScheme}) {
    const docShell = this._frameTree.mainFrame().docShell();
    const cv = docShell.contentViewer;
    if (type === '')
      cv.stopEmulatingMedium();
    else if (type)
      cv.emulateMedium(type);
    switch (colorScheme) {
      case 'light': cv.emulatePrefersColorScheme(cv.PREFERS_COLOR_SCHEME_LIGHT); break;
      case 'dark': cv.emulatePrefersColorScheme(cv.PREFERS_COLOR_SCHEME_DARK); break;
      case 'no-preference': cv.emulatePrefersColorScheme(cv.PREFERS_COLOR_SCHEME_NO_PREFERENCE); break;
    }
  }

  addScriptToEvaluateOnNewDocument({script, worldName}) {
    const scriptId = helper.generateId();
    this._scriptsToEvaluateOnNewDocument.set(scriptId, {script, worldName});
    if (worldName) {
      for (const frameData of this._frameData.values())
        frameData.createIsolatedWorld(worldName);
    }
    return {scriptId};
  }

  removeScriptToEvaluateOnNewDocument({scriptId}) {
    this._scriptsToEvaluateOnNewDocument.delete(scriptId);
  }

  setCacheDisabled({cacheDisabled}) {
    const enable = Ci.nsIRequest.LOAD_NORMAL;
    const disable = Ci.nsIRequest.LOAD_BYPASS_CACHE |
                  Ci.nsIRequest.INHIBIT_CACHING;

    const docShell = this._frameTree.mainFrame().docShell();
    docShell.defaultLoadFlags = cacheDisabled ? disable : enable;
  }

  enable() {
    if (this._enabled)
      return;

    this._enabled = true;
    // Dispatch frameAttached events for all initial frames
    for (const frame of this._frameTree.frames()) {
      this._onFrameAttached(frame);
      if (frame.url())
        this._onNavigationCommitted(frame);
      if (frame.pendingNavigationId())
        this._onNavigationStarted(frame);
    }

    this._eventListeners = [
      helper.addObserver(this._filePickerShown.bind(this), 'juggler-file-picker-shown'),
      helper.addObserver(this._onDOMWindowCreated.bind(this), 'content-document-global-created'),
      helper.addEventListener(this._session.mm(), 'DOMContentLoaded', this._onDOMContentLoaded.bind(this)),
      helper.addEventListener(this._session.mm(), 'pageshow', this._onLoad.bind(this)),
      helper.addObserver(this._onDocumentOpenLoad.bind(this), 'juggler-document-open-loaded'),
      helper.addEventListener(this._session.mm(), 'error', this._onError.bind(this)),
      helper.on(this._frameTree, 'frameattached', this._onFrameAttached.bind(this)),
      helper.on(this._frameTree, 'framedetached', this._onFrameDetached.bind(this)),
      helper.on(this._frameTree, 'navigationstarted', this._onNavigationStarted.bind(this)),
      helper.on(this._frameTree, 'navigationcommitted', this._onNavigationCommitted.bind(this)),
      helper.on(this._frameTree, 'navigationaborted', this._onNavigationAborted.bind(this)),
      helper.on(this._frameTree, 'samedocumentnavigation', this._onSameDocumentNavigation.bind(this)),
      helper.on(this._frameTree, 'pageready', () => this._session.emitEvent('Page.ready', {})),
    ];

    this._wdm.addListener(this._wdmListener);
    for (const workerDebugger of this._wdm.getWorkerDebuggerEnumerator())
      this._onWorkerCreated(workerDebugger);

    if (this._frameTree.isPageReady())
      this._session.emitEvent('Page.ready', {});
  }

  setInterceptFileChooserDialog({enabled}) {
    this._docShell.fileInputInterceptionEnabled = !!enabled;
  }

  _frameForWorker(workerDebugger) {
    if (workerDebugger.type !== Ci.nsIWorkerDebugger.TYPE_DEDICATED)
      return null;
    const docShell = workerDebugger.window.docShell;
    const frame = this._frameTree.frameForDocShell(docShell);
    return frame ? this._frameData.get(frame) : null;
  }

  _onWorkerCreated(workerDebugger) {
    const frameData = this._frameForWorker(workerDebugger);
    if (frameData)
      frameData.workerCreated(workerDebugger);
  }

  _onWorkerDestroyed(workerDebugger) {
    const frameData = this._frameForWorker(workerDebugger);
    if (frameData)
      frameData.workerDestroyed(workerDebugger);
  }

  sendMessageToWorker({frameId, workerId, message}) {
    const frame = this._frameTree.frame(frameId);
    if (!frame)
      throw new Error('Failed to find frame with id = ' + frameId);
    this._frameData.get(frame).sendMessageToWorker(workerId, message);
  }

  _filePickerShown(inputElement) {
    if (inputElement.ownerGlobal.docShell !== this._docShell)
      return;
    const frameData = this._findFrameForNode(inputElement);
    this._session.emitEvent('Page.fileChooserOpened', {
      executionContextId: frameData.mainContext.id(),
      element: frameData.mainContext.rawValueToRemoteObject(inputElement)
    });
  }

  _findFrameForNode(node) {
    return Array.from(this._frameData.values()).find(data => {
      const doc = data._frame.domWindow().document;
      return node === doc || node.ownerDocument === doc;
    });
  }

  _onDOMContentLoaded(event) {
    const docShell = event.target.ownerGlobal.docShell;
    const frame = this._frameTree.frameForDocShell(docShell);
    if (!frame)
      return;
    this._session.emitEvent('Page.eventFired', {
      frameId: frame.id(),
      name: 'DOMContentLoaded',
    });
  }

  _onError(errorEvent) {
    const docShell = errorEvent.target.ownerGlobal.docShell;
    const frame = this._frameTree.frameForDocShell(docShell);
    if (!frame)
      return;
    this._session.emitEvent('Page.uncaughtError', {
      frameId: frame.id(),
      message: errorEvent.message,
      stack: errorEvent.error.stack
    });
  }

  _onDocumentOpenLoad(document) {
    const docShell = document.ownerGlobal.docShell;
    const frame = this._frameTree.frameForDocShell(docShell);
    if (!frame)
      return;
    this._session.emitEvent('Page.eventFired', {
      frameId: frame.id(),
      name: 'load'
    });
  }

  _onLoad(event) {
    const docShell = event.target.ownerGlobal.docShell;
    const frame = this._frameTree.frameForDocShell(docShell);
    if (!frame)
      return;
    this._session.emitEvent('Page.eventFired', {
      frameId: frame.id(),
      name: 'load'
    });
  }

  _onNavigationStarted(frame) {
    this._session.emitEvent('Page.navigationStarted', {
      frameId: frame.id(),
      navigationId: frame.pendingNavigationId(),
      url: frame.pendingNavigationURL(),
    });
  }

  _onNavigationAborted(frame, navigationId, errorText) {
    this._session.emitEvent('Page.navigationAborted', {
      frameId: frame.id(),
      navigationId,
      errorText,
    });
  }

  _onSameDocumentNavigation(frame) {
    this._session.emitEvent('Page.sameDocumentNavigation', {
      frameId: frame.id(),
      url: frame.url(),
    });
  }

  _onNavigationCommitted(frame) {
    this._session.emitEvent('Page.navigationCommitted', {
      frameId: frame.id(),
      navigationId: frame.lastCommittedNavigationId() || undefined,
      url: frame.url(),
      name: frame.name(),
    });
  }

  _onDOMWindowCreated(window) {
    const docShell = window.docShell;
    const frame = this._frameTree.frameForDocShell(docShell);
    if (!frame)
      return;
    this._frameData.get(frame).reset();
  }

  _onFrameAttached(frame) {
    this._session.emitEvent('Page.frameAttached', {
      frameId: frame.id(),
      parentFrameId: frame.parentFrame() ? frame.parentFrame().id() : undefined,
    });
    this._frameData.set(frame, new FrameData(this, frame));
  }

  _onFrameDetached(frame) {
    this._frameData.delete(frame);
    this._session.emitEvent('Page.frameDetached', {
      frameId: frame.id(),
    });
  }

  dispose() {
    for (const frameData of this._frameData.values())
      frameData.dispose();
    helper.removeListeners(this._eventListeners);
    this._wdm.removeListener(this._wdmListener);
  }

  async navigate({frameId, url, referer}) {
    try {
      const uri = NetUtil.newURI(url);
    } catch (e) {
      throw new Error(`Invalid url: "${url}"`);
    }
    let referrerURI = null;
    let referrerInfo = null;
    if (referer) {
      try {
        referrerURI = NetUtil.newURI(referer);
        const ReferrerInfo = Components.Constructor(
          '@mozilla.org/referrer-info;1',
          'nsIReferrerInfo',
          'init'
        );
        referrerInfo = new ReferrerInfo(Ci.nsIHttpChannel.REFERRER_POLICY_UNSET, true, referrerURI);
      } catch (e) {
        throw new Error(`Invalid referer: "${referer}"`);
      }
    }
    const frame = this._frameTree.frame(frameId);
    const docShell = frame.docShell().QueryInterface(Ci.nsIWebNavigation);
    docShell.loadURI(url, {
      flags: Ci.nsIWebNavigation.LOAD_FLAGS_NONE,
      referrerInfo,
      postData: null,
      headers: null,
    });
    return {navigationId: frame.pendingNavigationId(), navigationURL: frame.pendingNavigationURL()};
  }

  async reload({frameId, url}) {
    const frame = this._frameTree.frame(frameId);
    const docShell = frame.docShell().QueryInterface(Ci.nsIWebNavigation);
    docShell.reload(Ci.nsIWebNavigation.LOAD_FLAGS_NONE);
    return {navigationId: frame.pendingNavigationId(), navigationURL: frame.pendingNavigationURL()};
  }

  async goBack({frameId, url}) {
    const frame = this._frameTree.frame(frameId);
    const docShell = frame.docShell();
    if (!docShell.canGoBack)
      return {navigationId: null, navigationURL: null};
    docShell.goBack();
    return {navigationId: frame.pendingNavigationId(), navigationURL: frame.pendingNavigationURL()};
  }

  async goForward({frameId, url}) {
    const frame = this._frameTree.frame(frameId);
    const docShell = frame.docShell();
    if (!docShell.canGoForward)
      return {navigationId: null, navigationURL: null};
    docShell.goForward();
    return {navigationId: frame.pendingNavigationId(), navigationURL: frame.pendingNavigationURL()};
  }

  addBinding({name}) {
    if (this._bindingsToAdd.has(name))
      throw new Error(`Binding with name ${name} already exists`);
    this._bindingsToAdd.add(name);
    for (const frameData of this._frameData.values())
      frameData.exposeFunction(name);
  }

  async adoptNode({frameId, objectId, executionContextId}) {
    const frame = this._frameTree.frame(frameId);
    if (!frame)
      throw new Error('Failed to find frame with id = ' + frameId);
    const unsafeObject = this._frameData.get(frame).unsafeObject(objectId);
    const context = this._runtime.findExecutionContext(executionContextId);
    const fromPrincipal = unsafeObject.nodePrincipal;
    const toFrame = this._frameTree.frame(context.auxData().frameId);
    const toPrincipal = toFrame.domWindow().document.nodePrincipal;
    if (!toPrincipal.subsumes(fromPrincipal))
      return { remoteObject: null };
    return { remoteObject: context.rawValueToRemoteObject(unsafeObject) };
  }

  async setFileInputFiles({objectId, frameId, files}) {
    const frame = this._frameTree.frame(frameId);
    if (!frame)
      throw new Error('Failed to find frame with id = ' + frameId);
    const unsafeObject = this._frameData.get(frame).unsafeObject(objectId);
    if (!unsafeObject)
      throw new Error('Object is not input!');
    const nsFiles = await Promise.all(files.map(filePath => File.createFromFileName(filePath)));
    unsafeObject.mozSetFileArray(nsFiles);
  }

  getContentQuads({objectId, frameId}) {
    const frame = this._frameTree.frame(frameId);
    if (!frame)
      throw new Error('Failed to find frame with id = ' + frameId);
    const unsafeObject = this._frameData.get(frame).unsafeObject(objectId);
    if (!unsafeObject.getBoxQuads)
      throw new Error('RemoteObject is not a node');
    const quads = unsafeObject.getBoxQuads({relativeTo: this._frameTree.mainFrame().domWindow().document}).map(quad => {
      return {
        p1: {x: quad.p1.x, y: quad.p1.y},
        p2: {x: quad.p2.x, y: quad.p2.y},
        p3: {x: quad.p3.x, y: quad.p3.y},
        p4: {x: quad.p4.x, y: quad.p4.y},
      };
    });
    return {quads};
  }

  describeNode({objectId, frameId}) {
    const frame = this._frameTree.frame(frameId);
    if (!frame)
      throw new Error('Failed to find frame with id = ' + frameId);
    const unsafeObject = this._frameData.get(frame).unsafeObject(objectId);
    const browsingContextGroup = frame.docShell().browsingContext.group;
    const frames = this._frameTree.allFramesInBrowsingContextGroup(browsingContextGroup);
    let contentFrame;
    let ownerFrame;
    for (const frame of frames) {
      if (unsafeObject.contentWindow && frame.docShell() === unsafeObject.contentWindow.docShell)
        contentFrame = frame;
      const document = frame.domWindow().document;
      if (unsafeObject === document || unsafeObject.ownerDocument === document)
        ownerFrame = frame;
    }
    return {
      contentFrameId: contentFrame ? contentFrame.id() : undefined,
      ownerFrameId: ownerFrame ? ownerFrame.id() : undefined,
    };
  }

  async scrollIntoViewIfNeeded({objectId, frameId, rect}) {
    const frame = this._frameTree.frame(frameId);
    if (!frame)
      throw new Error('Failed to find frame with id = ' + frameId);
    const unsafeObject = this._frameData.get(frame).unsafeObject(objectId);
    if (!unsafeObject.isConnected)
      throw new Error('Node is detached from document');
    await this._scrollNodeIntoViewIfNeeded(unsafeObject);
    const box = this._getBoundingBox(unsafeObject);
    if (rect) {
      box.x += rect.x;
      box.y += rect.y;
      box.width = rect.width;
      box.height = rect.height;
    }
    this._scrollRectIntoViewIfNeeded(unsafeObject, box);
  }

  async _scrollNodeIntoViewIfNeeded(node) {
    if (node.nodeType !== 1)
      node = node.parentElement;
    if (!node.ownerDocument || !node.ownerDocument.defaultView)
      return;
    const global = node.ownerDocument.defaultView;
    const visibleRatio = await new Promise(resolve => {
      const observer = new global.IntersectionObserver(entries => {
        resolve(entries[0].intersectionRatio);
        observer.disconnect();
      });
      observer.observe(node);
      // Firefox doesn't call IntersectionObserver callback unless
      // there are rafs.
      global.requestAnimationFrame(() => {});
    });
    if (visibleRatio !== 1.0)
      node.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
  }

  _scrollRectIntoViewIfNeeded(node, rect) {
    // TODO: implement.
  }

  _getBoundingBox(unsafeObject) {
    if (!unsafeObject.getBoxQuads)
      throw new Error('RemoteObject is not a node');
    const quads = unsafeObject.getBoxQuads({relativeTo: this._frameTree.mainFrame().domWindow().document});
    if (!quads.length)
      return;
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const quad of quads) {
      const boundingBox = quad.getBounds();
      x1 = Math.min(boundingBox.x, x1);
      y1 = Math.min(boundingBox.y, y1);
      x2 = Math.max(boundingBox.x + boundingBox.width, x2);
      y2 = Math.max(boundingBox.y + boundingBox.height, y2);
    }
    return {x: x1, y: y1, width: x2 - x1, height: y2 - y1};
  }

  async getBoundingBox({frameId, objectId}) {
    const frame = this._frameTree.frame(frameId);
    if (!frame)
      throw new Error('Failed to find frame with id = ' + frameId);
    const unsafeObject = this._frameData.get(frame).unsafeObject(objectId);
    const box = this._getBoundingBox(unsafeObject);
    if (!box)
      return {boundingBox: null};
    return {boundingBox: {x: box.x + frame.domWindow().scrollX, y: box.y + frame.domWindow().scrollY, width: box.width, height: box.height}};
  }

  async screenshot({mimeType, fullPage, clip}) {
    const content = this._session.mm().content;
    if (clip) {
      const data = takeScreenshot(content, clip.x, clip.y, clip.width, clip.height, mimeType);
      return {data};
    }
    if (fullPage) {
      const rect = content.document.documentElement.getBoundingClientRect();
      const width = content.innerWidth + content.scrollMaxX - content.scrollMinX;
      const height = content.innerHeight + content.scrollMaxY - content.scrollMinY;
      const data = takeScreenshot(content, 0, 0, width, height, mimeType);
      return {data};
    }
    const data = takeScreenshot(content, content.scrollX, content.scrollY, content.innerWidth, content.innerHeight, mimeType);
    return {data};
  }

  async dispatchKeyEvent({type, keyCode, code, key, repeat, location, text}) {
    const frame = this._frameTree.mainFrame();
    const tip = frame.textInputProcessor();
    if (key === 'Meta' && Services.appinfo.OS !== 'Darwin')
      key = 'OS';
    else if (key === 'OS' && Services.appinfo.OS === 'Darwin')
      key = 'Meta';
    let keyEvent = new (frame.domWindow().KeyboardEvent)("", {
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

  async dispatchTouchEvent({type, touchPoints, modifiers}) {
    const frame = this._frameTree.mainFrame();
    const defaultPrevented = frame.domWindow().windowUtils.sendTouchEvent(
      type.toLowerCase(),
      touchPoints.map((point, id) => id),
      touchPoints.map(point => point.x),
      touchPoints.map(point => point.y),
      touchPoints.map(point => point.radiusX === undefined ? 1.0 : point.radiusX),
      touchPoints.map(point => point.radiusY === undefined ? 1.0 : point.radiusY),
      touchPoints.map(point => point.rotationAngle === undefined ? 0.0 : point.rotationAngle),
      touchPoints.map(point => point.force === undefined ? 1.0 : point.force),
      touchPoints.length,
      modifiers);
    return {defaultPrevented};
  }

  async dispatchMouseEvent({type, x, y, button, clickCount, modifiers, buttons}) {
    const frame = this._frameTree.mainFrame();
    frame.domWindow().windowUtils.sendMouseEvent(
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
      buttons);
    if (type === 'mousedown' && button === 2) {
      frame.domWindow().windowUtils.sendMouseEvent(
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

  async insertText({text}) {
    const frame = this._frameTree.mainFrame();
    frame.textInputProcessor().commitCompositionWith(text);
  }

  async crash() {
    dump(`Crashing intentionally\n`);
    // This is to intentionally crash the frame.
    // We crash by using js-ctypes and dereferencing
    // a bad pointer. The crash should happen immediately
    // upon loading this frame script.
    const { ctypes } = ChromeUtils.import('resource://gre/modules/ctypes.jsm');
    ChromeUtils.privateNoteIntentionalCrash();
    const zero = new ctypes.intptr_t(8);
    const badptr = ctypes.cast(zero, ctypes.PointerType(ctypes.int32_t));
    badptr.contents;
  }

  async getFullAXTree({objectId}) {
    let unsafeObject = null;
    if (objectId) {
      unsafeObject = this._frameData.get(this._frameTree.mainFrame()).unsafeObject(objectId);
      if (!unsafeObject)
        throw new Error(`No object found for id "${objectId}"`);
    }

    const service = Cc["@mozilla.org/accessibilityService;1"]
      .getService(Ci.nsIAccessibilityService);
    const document = this._frameTree.mainFrame().domWindow().document;
    const docAcc = service.getAccessibleFor(document);

    while (docAcc.document.isUpdatePendingForJugglerAccessibility)
      await new Promise(x => this._frameTree.mainFrame().domWindow().requestAnimationFrame(x));

    async function waitForQuiet() {
      let state = {};
      docAcc.getState(state, {});
      if ((state.value & Ci.nsIAccessibleStates.STATE_BUSY) == 0)
        return;
      let resolve, reject;
      const promise = new Promise((x, y) => {resolve = x, reject = y});
      let eventObserver = {
        observe(subject, topic) {
          if (topic !== "accessible-event") {
            return;
          }

          // If event type does not match expected type, skip the event.
          let event = subject.QueryInterface(Ci.nsIAccessibleEvent);
          if (event.eventType !== Ci.nsIAccessibleEvent.EVENT_STATE_CHANGE) {
            return;
          }

          // If event's accessible does not match expected accessible,
          // skip the event.
          if (event.accessible !== docAcc) {
            return;
          }

          Services.obs.removeObserver(this, "accessible-event");
          resolve();
        },
      };
      Services.obs.addObserver(eventObserver, "accessible-event");
      return promise;
    }
    function buildNode(accElement) {
      let a = {}, b = {};
      accElement.getState(a, b);
      const tree = {
        role: service.getStringRole(accElement.role),
        name: accElement.name || '',
      };
      if (unsafeObject && unsafeObject === accElement.DOMNode)
        tree.foundObject = true;
      for (const userStringProperty of [
        'value',
        'description'
      ]) {
        tree[userStringProperty] = accElement[userStringProperty] || undefined;
      }

      const states = {};
      for (const name of service.getStringStates(a.value, b.value))
        states[name] = true;
      for (const name of ['selected',
        'focused',
        'pressed',
        'focusable',
        'haspopup',
        'required',
        'invalid',
        'modal',
        'editable',
        'busy',
        'checked',
        'multiselectable']) {
        if (states[name])
          tree[name] = true;
      }

      if (states['multi line'])
        tree['multiline'] = true;
      if (states['editable'] && states['readonly'])
        tree['readonly'] = true;
      if (states['checked'])
        tree['checked'] = true;
      if (states['mixed'])
        tree['checked'] = 'mixed';
      if (states['expanded'])
        tree['expanded'] = true;
      else if (states['collapsed'])
        tree['expanded'] = false;
      if (!states['enabled'])
        tree['disabled'] = true;

      const attributes = {};
      if (accElement.attributes) {
        for (const { key, value } of accElement.attributes.enumerate()) {
          attributes[key] = value;
        }
      }
      for (const numericalProperty of ['level']) {
        if (numericalProperty in attributes)
          tree[numericalProperty] = parseFloat(attributes[numericalProperty]);
      }
      for (const stringProperty of ['tag', 'roledescription', 'valuetext', 'orientation', 'autocomplete', 'keyshortcuts']) {
        if (stringProperty in attributes)
          tree[stringProperty] = attributes[stringProperty];
      }
      const children = [];

      for (let child = accElement.firstChild; child; child = child.nextSibling) {
        children.push(buildNode(child));
      }
      if (children.length)
        tree.children = children;
      return tree;
    }
    await waitForQuiet();
    return {
      tree: buildNode(docAcc)
    };
  }
}

function takeScreenshot(win, left, top, width, height, mimeType) {
  const MAX_SKIA_DIMENSIONS = 32767;

  const scale = win.devicePixelRatio;
  const canvasWidth = width * scale;
  const canvasHeight = height * scale;

  if (canvasWidth > MAX_SKIA_DIMENSIONS || canvasHeight > MAX_SKIA_DIMENSIONS)
    throw new Error('Cannot take screenshot larger than ' + MAX_SKIA_DIMENSIONS);

  const canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  let ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.drawWindow(win, left, top, width, height, 'rgb(255,255,255)', ctx.DRAWWINDOW_DRAW_CARET);
  const dataURL = canvas.toDataURL(mimeType);
  return dataURL.substring(dataURL.indexOf(',') + 1);
};

var EXPORTED_SYMBOLS = ['PageAgent'];
this.PageAgent = PageAgent;

