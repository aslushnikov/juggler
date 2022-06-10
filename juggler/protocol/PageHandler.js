/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");
const {NetworkObserver, PageNetwork} = ChromeUtils.import('chrome://juggler/content/NetworkObserver.js');
const {PageTarget} = ChromeUtils.import('chrome://juggler/content/TargetRegistry.js');
const { BrowserFrameTree } = ChromeUtils.import("chrome://juggler/content/BrowserFrameTree.js");

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const XUL_NS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';
const helper = new Helper();

class PageHandler {
  constructor(target, session) {
    this._session = session;

    this._pageTarget = target;
    this._frameTree = target.frameTree();
    this._pageNetwork = PageNetwork.forPageTarget(target);

    this._reportedFrameIds = new Set();
    this._networkEventsForUnreportedFrameIds = new Map();

    // `Page.ready` protocol event is emitted whenever page has completed initialization, e.g.
    // finished all the transient navigations to the `about:blank`.
    //
    // We'd like to avoid reporting meaningful events before the `Page.ready` since they are likely
    // to be ignored by the protocol clients.
    this._isPageReady = false;

    if (this._pageTarget.videoRecordingInfo())
      this._onVideoRecordingStarted();

    for (const frame of this._frameTree.allFrames()) {
      this._onFrameAttached(frame);
      if (frame.pendingNavigation())
        this._onNavigationStarted(frame);
    }

    const BFTEvents = BrowserFrameTree.Events;

    const emitWorkerEvent = eventName => {
      return (workerId, params) => {
        this._session.emitEvent('Page.dispatchMessageFromWorker', {
          workerId,
          message: JSON.stringify({method: eventName, params}),
        });
      }
    }

    const emitProtocolEvent = eventName => {
      return (...args) => this._session.emitEvent(eventName, ...args);
    }

    this._eventListeners = [
      helper.on(this._pageTarget, PageTarget.Events.DialogOpened, this._onDialogOpened.bind(this)),
      helper.on(this._pageTarget, PageTarget.Events.DialogClosed, this._onDialogClosed.bind(this)),
      helper.on(this._pageTarget, PageTarget.Events.Crashed, () => {
        this._session.emitEvent('Page.crashed', {});
      }),
      helper.on(this._pageTarget, PageTarget.Events.ScreencastStarted, this._onVideoRecordingStarted.bind(this)),
      helper.on(this._pageTarget, PageTarget.Events.ScreencastFrame, this._onScreencastFrame.bind(this)),

      helper.on(this._pageNetwork, PageNetwork.Events.Request, this._handleNetworkEvent.bind(this, 'Network.requestWillBeSent')),
      helper.on(this._pageNetwork, PageNetwork.Events.Response, this._handleNetworkEvent.bind(this, 'Network.responseReceived')),
      helper.on(this._pageNetwork, PageNetwork.Events.RequestFinished, this._handleNetworkEvent.bind(this, 'Network.requestFinished')),
      helper.on(this._pageNetwork, PageNetwork.Events.RequestFailed, this._handleNetworkEvent.bind(this, 'Network.requestFailed')),

      helper.on(this._frameTree, BFTEvents.FrameAttached, this._onFrameAttached.bind(this)),
      helper.on(this._frameTree, BFTEvents.FrameDetached, this._onFrameDetached.bind(this)),
      helper.on(this._frameTree, BFTEvents.NavigationStarted, emitProtocolEvent('Page.navigationStarted')),
      helper.on(this._frameTree, BFTEvents.NavigationCommitted, emitProtocolEvent('Page.navigationCommitted')),
      helper.on(this._frameTree, BFTEvents.NavigationAborted, emitProtocolEvent('Page.navigationAborted')),
      helper.on(this._frameTree, BFTEvents.SameDocumentNavigation, emitProtocolEvent('Page.sameDocumentNavigation')),
      helper.on(this._frameTree, BFTEvents.BindingCalled, emitProtocolEvent('Page.bindingCalled')),
      helper.on(this._frameTree, BFTEvents.MessageFromWorker, emitProtocolEvent('Page.dispatchMessageFromWorker')),
      helper.on(this._frameTree, BFTEvents.EventFired, emitProtocolEvent('Page.eventFired')),
      helper.on(this._frameTree, BFTEvents.Ready, this._onPageReady.bind(this)),
      helper.on(this._frameTree, BFTEvents.ExecutionContextCreated, emitProtocolEvent('Runtime.executionContextCreated')),
      helper.on(this._frameTree, BFTEvents.ExecutionContextDestroyed, emitProtocolEvent('Runtime.executionContextDestroyed')),
      helper.on(this._frameTree, BFTEvents.FileChooserOpened, emitProtocolEvent('Page.fileChooserOpened')),
      helper.on(this._frameTree, BFTEvents.LinkClicked, emitProtocolEvent('Page.linkClicked')),
      helper.on(this._frameTree, BFTEvents.WillOpenNewWindowAsynchronously, emitProtocolEvent('Page.willOpenNewWindowAsynchronously')),
      helper.on(this._frameTree, BFTEvents.UncaughtError, emitProtocolEvent('Page.uncaughtError')),
      helper.on(this._frameTree, BFTEvents.WebSocketCreated, emitProtocolEvent('Page.webSocketCreated')),
      helper.on(this._frameTree, BFTEvents.WebSocketOpened, emitProtocolEvent('Page.webSocketOpened')),
      helper.on(this._frameTree, BFTEvents.WebSocketClosed, emitProtocolEvent('Page.webSocketClosed')),
      helper.on(this._frameTree, BFTEvents.WebSocketFrameReceived, emitProtocolEvent('Page.webSocketFrameReceived')),
      helper.on(this._frameTree, BFTEvents.WebSocketFrameSent, emitProtocolEvent('Page.webSocketFrameSent')),
      helper.on(this._frameTree, BFTEvents.Console, emitProtocolEvent('Runtime.console')),

      helper.on(this._frameTree, BFTEvents.WorkerCreated, emitProtocolEvent('Page.workerCreated')),
      helper.on(this._frameTree, BFTEvents.WorkerDestroyed, emitProtocolEvent('Page.workerDestroyed')),
      helper.on(this._frameTree, BFTEvents.WorkerExecutionContextCreated, emitWorkerEvent('Runtime.executionContextCreated')),
      helper.on(this._frameTree, BFTEvents.WorkerExecutionContextDestroyed, emitWorkerEvent('Runtime.executionContextDestroyed')),
      helper.on(this._frameTree, BFTEvents.WorkerConsole, emitWorkerEvent('Runtime.console')),
    ];
  }

  async dispose() {
    helper.removeListeners(this._eventListeners);
  }

  _onVideoRecordingStarted() {
    const info = this._pageTarget.videoRecordingInfo();
    this._session.emitEvent('Page.videoRecordingStarted', { screencastId: info.sessionId, file: info.file });
  }

  _onScreencastFrame(params) {
    this._session.emitEvent('Page.screencastFrame', params);
  }

  _onPageReady() {
    this._isPageReady = true;
    this._session.emitEvent('Page.ready');
    for (const dialog of this._pageTarget.dialogs())
      this._onDialogOpened(dialog);
  }

  _onDialogOpened(dialog) {
    if (!this._isPageReady)
      return;
    this._session.emitEvent('Page.dialogOpened', {
      dialogId: dialog.id(),
      type: dialog.type(),
      message: dialog.message(),
      defaultValue: dialog.defaultValue(),
    });
  }

  _onDialogClosed(dialog) {
    if (!this._isPageReady)
      return;
    this._session.emitEvent('Page.dialogClosed', { dialogId: dialog.id(), });
  }

  _handleNetworkEvent(protocolEventName, eventDetails, frameId) {
    if (!this._reportedFrameIds.has(frameId)) {
      let events = this._networkEventsForUnreportedFrameIds.get(frameId);
      if (!events) {
        events = [];
        this._networkEventsForUnreportedFrameIds.set(frameId, events);
      }
      events.push({eventName: protocolEventName, eventDetails});
    } else {
      this._session.emitEvent(protocolEventName, eventDetails);
    }
  }

  _onNavigationStarted(frame) {
    this._session.emitEvent('Page.navigationStarted', {
      frameId: frame.frameId(),
      navigationId: frame.pendingNavigation().navigationId,
      url: frame.pendingNavigation().navigationURL,
    });
  }

  _onFrameAttached(frame) {
    const frameId = frame.frameId();
    this._session.emitEvent('Page.frameAttached', {
      frameId,
      parentFrameId: frame.parent()?.frameId()
    });
    this._reportedFrameIds.add(frameId);
    const events = this._networkEventsForUnreportedFrameIds.get(frameId) || [];
    this._networkEventsForUnreportedFrameIds.delete(frameId);
    for (const {eventName, eventDetails} of events)
      this._session.emitEvent(eventName, eventDetails);
  }

  _onFrameDetached(frame) {
    this._session.emitEvent('Page.frameAttached', {
      frameId: frame.frameId(),
    });
  }

  async ['Page.close']({runBeforeUnload}) {
    // Postpone target close to deliver response in session.
    Services.tm.dispatchToMainThread(() => {
      this._pageTarget.close(runBeforeUnload);
    });
  }

  async ['Page.setViewportSize']({viewportSize}) {
    await this._pageTarget.setViewportSize(viewportSize === null ? undefined : viewportSize);
  }

  async ['Runtime.evaluate'](options) {
    return await this._frameTree.evaluate(options);
  }

  async ['Runtime.callFunction'](options) {
    return await this._frameTree.callFunction(options);
  }

  async ['Runtime.getObjectProperties'](options) {
    return await this._frameTree.getObjectProperties(options);
  }

  async ['Runtime.disposeObject'](options) {
    return await this._frameTree.disposeObject(options);
  }

  async ['Network.getResponseBody']({requestId}) {
    return this._pageNetwork.getResponseBody(requestId);
  }

  async ['Network.setExtraHTTPHeaders']({headers}) {
    this._pageNetwork.setExtraHTTPHeaders(headers);
  }

  async ['Network.setRequestInterception']({enabled}) {
    if (enabled)
      this._pageNetwork.enableRequestInterception();
    else
      this._pageNetwork.disableRequestInterception();
  }

  async ['Network.resumeInterceptedRequest']({requestId, url, method, headers, postData}) {
    this._pageNetwork.resumeInterceptedRequest(requestId, url, method, headers, postData);
  }

  async ['Network.abortInterceptedRequest']({requestId, errorCode}) {
    this._pageNetwork.abortInterceptedRequest(requestId, errorCode);
  }

  async ['Network.fulfillInterceptedRequest']({requestId, status, statusText, headers, base64body}) {
    this._pageNetwork.fulfillInterceptedRequest(requestId, status, statusText, headers, base64body);
  }

  async ['Accessibility.getFullAXTree']({ objectId }) {
    return await this._frameTree.getFullAXTree({ objectId });
  }

  async ['Page.setFileInputFiles'](options) {
    const frame = this._frameTree.frameIdToFrame(options.frameId);
    return await frame.setFileInputFiles(options);
  }

  async ['Page.setEmulatedMedia']({colorScheme, type, reducedMotion, forcedColors}) {
    this._pageTarget.setColorScheme(colorScheme || null);
    this._pageTarget.setReducedMotion(reducedMotion || null);
    this._pageTarget.setForcedColors(forcedColors || null);
    this._pageTarget.setEmulatedMedia(type);
  }

  async ['Page.bringToFront'](options) {
    this._pageTarget._window.focus();
  }

  async ['Page.addBinding']({ name, script, worldName }) {
    return await this._frameTree.addBinding({ name, script, worldName });
  }

  async ['Page.adoptNode'](options) {
    return await this._frameTree.adoptNode(options);
  }

  async ['Page.screenshot'](options) {
    return await this._frameTree.screenshot(options);
  }

  async ['Page.getContentQuads']({ frameId, objectId }) {
    const frame = this._frameTree.frameIdToFrameOrDie(frameId);
    return await frame.getContentQuads({ objectId });
  }

  async ['Page.navigate']({ frameId, url, referrer }) {
    const frame = this._frameTree.frameIdToFrameOrDie(frameId);
    return await frame.navigate({ url, referrer, frameId });
  }

  async ['Page.goBack']({ frameId }) {
    const frame = this._frameTree.frameIdToFrameOrDie(frameId);
    return await frame.goBack();
  }

  async ['Page.goForward']({ frameId }) {
    const frame = this._frameTree.frameIdToFrameOrDie(frameId);
    return await frame.goForward();
  }

  async ['Page.reload']({ frameId }) {
    const frame = this._frameTree.frameIdToFrameOrDie(frameId);
    return await frame.reload();
  }

  async ['Page.describeNode']({ frameId, objectId }) {
    return await this._frameTree.describeNode(frameId, objectId);
  }

  async ['Page.scrollIntoViewIfNeeded']({ frameId, objectId, rect }) {
    const frame = this._frameTree.frameIdToFrameOrDie(frameId);
    return await frame.scrollIntoViewIfNeeded(objectId, rect);
  }

  async ['Page.setInitScripts']({ scripts }) {
    return await this._frameTree.setInitScripts(scripts);
  }

  async ['Page.dispatchKeyEvent'](options) {
    return await this._frameTree.dispatchKeyEvent(options);
  }

  async ['Page.dispatchTouchEvent'](options) {
    return await this._frameTree.dispatchTouchEvent(options);
  }

  async ['Page.dispatchTapEvent'](options) {
    return await this._frameTree.dispatchTapEvent(options);
  }

  async ['Page.dispatchMouseEvent'](options) {
    return await this._frameTree.dispatchMouseEvent(options);
  }

  async ['Page.dispatchWheelEvent'](options) {
    return await this._frameTree.dispatchWheelEvent(options);
  }

  async ['Page.insertText'](options) {
    return await this._frameTree.insertText(options);
  }

  async ['Page.crash']() {
    return await this._frameTree.forceRendererCrash();
  }

  async ['Page.handleDialog']({dialogId, accept, promptText}) {
    const dialog = this._pageTarget.dialog(dialogId);
    if (!dialog)
      throw new Error('Failed to find dialog with id = ' + dialogId);
    if (accept)
      dialog.accept(promptText);
    else
      dialog.dismiss();
  }

  async ['Page.setInterceptFileChooserDialog']({ enabled }) {
    return await this._frameTree.setInterceptFileChooserDialog(enabled);
  }

  async ['Page.startScreencast'](options) {
    return await this._pageTarget.startScreencast(options);
  }

  async ['Page.screencastFrameAck'](options) {
    await this._pageTarget.screencastFrameAck(options);
  }

  async ['Page.stopScreencast'](options) {
    await this._pageTarget.stopScreencast(options);
  }

  async ['Page.sendMessageToWorker']({ frameId, workerId, message }) {
    const frame = this._frameTree.frameIdToFrameOrDie(frameId);
    return await frame.sendMessageToWorker(workerId, message);
  }
}

var EXPORTED_SYMBOLS = ['PageHandler'];
this.PageHandler = PageHandler;
