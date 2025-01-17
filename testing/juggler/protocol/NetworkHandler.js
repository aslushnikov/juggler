"use strict";

const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {NetworkObserver} = ChromeUtils.import('chrome://juggler/content/NetworkObserver.js');
const {TargetRegistry} = ChromeUtils.import("chrome://juggler/content/TargetRegistry.js");

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const XUL_NS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';
const FRAME_SCRIPT = "chrome://juggler/content/content/ContentSession.js";
const helper = new Helper();

class NetworkHandler {
  constructor(chromeSession, contentSession) {
    this._chromeSession = chromeSession;
    this._contentSession = contentSession;
    this._networkObserver = NetworkObserver.instance();
    this._httpActivity = new Map();
    this._enabled = false;
    this._browser = TargetRegistry.instance().tabForTarget(this._chromeSession.targetId()).linkedBrowser;
    this._requestInterception = false;
    this._eventListeners = [];
    this._pendingRequstWillBeSentEvents = new Set();
  }

  async enable() {
    if (this._enabled)
      return;
    this._enabled = true;
    this._eventListeners = [
      helper.on(this._networkObserver, 'request', this._onRequest.bind(this)),
      helper.on(this._networkObserver, 'response', this._onResponse.bind(this)),
      helper.on(this._networkObserver, 'requestfinished', this._onRequestFinished.bind(this)),
      helper.on(this._networkObserver, 'requestfailed', this._onRequestFailed.bind(this)),
      this._networkObserver.startTrackingBrowserNetwork(this._browser),
    ];
  }

  async getResponseBody({requestId}) {
    return this._networkObserver.getResponseBody(this._browser, requestId);
  }

  async setExtraHTTPHeaders({headers}) {
    this._networkObserver.setExtraHTTPHeaders(this._browser, headers);
  }

  async setRequestInterception({enabled}) {
    if (enabled)
      this._networkObserver.enableRequestInterception(this._browser);
    else
      this._networkObserver.disableRequestInterception(this._browser);
    // Right after we enable/disable request interception we need to await all pending
    // requestWillBeSent events before successfully returning from the method.
    await Promise.all(Array.from(this._pendingRequstWillBeSentEvents));
  }

  async resumeSuspendedRequest({requestId, headers}) {
    this._networkObserver.resumeSuspendedRequest(this._browser, requestId, headers);
  }

  async abortSuspendedRequest({requestId}) {
    this._networkObserver.abortSuspendedRequest(this._browser, requestId);
  }

  dispose() {
    helper.removeListeners(this._eventListeners);
  }

  _ensureHTTPActivity(requestId) {
    let activity = this._httpActivity.get(requestId);
    if (!activity) {
      activity = {
        _id: requestId,
        _lastSentEvent: null,
        request: null,
        response: null,
        complete: null,
        failed: null,
      };
      this._httpActivity.set(requestId, activity);
    }
    return activity;
  }

  _reportHTTPAcitivityEvents(activity) {
    // State machine - sending network events.
    if (!activity._lastSentEvent && activity.request) {
      this._chromeSession.emitEvent('Network.requestWillBeSent', activity.request);
      activity._lastSentEvent = 'requestWillBeSent';
    }
    if (activity._lastSentEvent === 'requestWillBeSent' && activity.response) {
      this._chromeSession.emitEvent('Network.responseReceived', activity.response);
      activity._lastSentEvent = 'responseReceived';
    }
    if (activity._lastSentEvent === 'responseReceived' && activity.complete) {
      this._chromeSession.emitEvent('Network.requestFinished', activity.complete);
      activity._lastSentEvent = 'requestFinished';
    }
    if (activity._lastSentEvent && activity.failed) {
      this._chromeSession.emitEvent('Network.requestFailed', activity.failed);
      activity._lastSentEvent = 'requestFailed';
    }

    // Clean up if request lifecycle is over.
    if (activity._lastSentEvent === 'requestFinished' || activity._lastSentEvent === 'requestFailed')
      this._httpActivity.delete(activity._id);
  }

  async _onRequest(httpChannel, eventDetails) {
    let pendingRequestCallback;
    let pendingRequestPromise = new Promise(x => pendingRequestCallback = x);
    this._pendingRequstWillBeSentEvents.add(pendingRequestPromise);
    let details = null;
    try {
      details = await this._contentSession.send('Page.requestDetails', {channelId: httpChannel.channelId});
    } catch (e) {
      if (this._contentSession.isDisposed()) {
        pendingRequestCallback();
        this._pendingRequstWillBeSentEvents.delete(pendingRequestPromise);
        return;
      }
    }
    const activity = this._ensureHTTPActivity(eventDetails.requestId);
    activity.request = {
      frameId: details ? details.frameId : undefined,
      ...eventDetails,
    };
    this._reportHTTPAcitivityEvents(activity);
    pendingRequestCallback();
    this._pendingRequstWillBeSentEvents.delete(pendingRequestPromise);
  }

  async _onResponse(httpChannel, eventDetails) {
    const activity = this._ensureHTTPActivity(eventDetails.requestId);
    activity.response = eventDetails;
    this._reportHTTPAcitivityEvents(activity);
  }

  async _onRequestFinished(httpChannel, eventDetails) {
    const activity = this._ensureHTTPActivity(eventDetails.requestId);
    activity.complete = eventDetails;
    this._reportHTTPAcitivityEvents(activity);
  }

  async _onRequestFailed(httpChannel, eventDetails) {
    const activity = this._ensureHTTPActivity(eventDetails.requestId);
    activity.failed = eventDetails;
    this._reportHTTPAcitivityEvents(activity);
  }
}

var EXPORTED_SYMBOLS = ['NetworkHandler'];
this.NetworkHandler = NetworkHandler;
