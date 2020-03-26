"use strict";

const {EventEmitter} = ChromeUtils.import('resource://gre/modules/EventEmitter.jsm');
const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");
const {NetUtil} = ChromeUtils.import('resource://gre/modules/NetUtil.jsm');
const {CommonUtils} = ChromeUtils.import("resource://services-common/utils.js");
const {TargetRegistry} = ChromeUtils.import('chrome://juggler/content/TargetRegistry.js');
const {BrowserContextManager} = ChromeUtils.import('chrome://juggler/content/BrowserContextManager.js');


const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;
const Cm = Components.manager;
const CC = Components.Constructor;
const helper = new Helper();

const BinaryInputStream = CC('@mozilla.org/binaryinputstream;1', 'nsIBinaryInputStream', 'setInputStream');
const BinaryOutputStream = CC('@mozilla.org/binaryoutputstream;1', 'nsIBinaryOutputStream', 'setOutputStream');
const StorageStream = CC('@mozilla.org/storagestream;1', 'nsIStorageStream', 'init');

// Cap response storage with 100Mb per tracked tab.
const MAX_RESPONSE_STORAGE_SIZE = 100 * 1024 * 1024;

/**
 * This is a nsIChannelEventSink implementation that monitors channel redirects.
 */
const SINK_CLASS_DESCRIPTION = "Juggler NetworkMonitor Channel Event Sink";
const SINK_CLASS_ID = Components.ID("{c2b4c83e-607a-405a-beab-0ef5dbfb7617}");
const SINK_CONTRACT_ID = "@mozilla.org/network/monitor/channeleventsink;1";
const SINK_CATEGORY_NAME = "net-channel-event-sinks";

class NetworkObserver {
  static instance() {
    return NetworkObserver._instance || null;
  }

  static initialize() {
    if (NetworkObserver._instance)
      return;
    NetworkObserver._instance = new NetworkObserver();
  }

  constructor() {
    EventEmitter.decorate(this);
    this._browserSessionCount = new Map();
    this._activityDistributor = Cc["@mozilla.org/network/http-activity-distributor;1"].getService(Ci.nsIHttpActivityDistributor);
    this._activityDistributor.addObserver(this);

    this._redirectMap = new Map();  // oldId => newId
    this._resumedRequestIdToHeaders = new Map();  // requestId => { headers }
    this._postResumeChannelIdToRequestId = new Map();  // post-resume channel id => pre-resume request id
    this._pendingAuthentication = new Set();  // pre-auth id
    this._postAuthChannelIdToRequestId = new Map();  // pre-auth id => post-auth id
    this._bodyListeners = new Map();  // channel id => ResponseBodyListener.

    this._channelSink = {
      QueryInterface: ChromeUtils.generateQI([Ci.nsIChannelEventSink]),
      asyncOnChannelRedirect: (oldChannel, newChannel, flags, callback) => {
        this._onRedirect(oldChannel, newChannel, flags);
        callback.onRedirectVerifyCallback(Cr.NS_OK);
      },
    };
    this._channelSinkFactory = {
      QueryInterface: ChromeUtils.generateQI([Ci.nsIFactory]),
      createInstance: (aOuter, aIID) => this._channelSink.QueryInterface(aIID),
    };
    // Register self as ChannelEventSink to track redirects.
    const registrar = Cm.QueryInterface(Ci.nsIComponentRegistrar);
    registrar.registerFactory(SINK_CLASS_ID, SINK_CLASS_DESCRIPTION, SINK_CONTRACT_ID, this._channelSinkFactory);
    Services.catMan.addCategoryEntry(SINK_CATEGORY_NAME, SINK_CONTRACT_ID, SINK_CONTRACT_ID, false, true);

    this._browsersWithEnabledInterception = new Set();
    this._browserInterceptors = new Map();  // Browser => (requestId => interceptor).
    this._extraHTTPHeaders = new Map();
    this._browserResponseStorages = new Map();

    this._eventListeners = [
      helper.addObserver(this._onRequest.bind(this), 'http-on-modify-request'),
      helper.addObserver(this._onResponse.bind(this, false /* fromCache */), 'http-on-examine-response'),
      helper.addObserver(this._onResponse.bind(this, true /* fromCache */), 'http-on-examine-cached-response'),
      helper.addObserver(this._onResponse.bind(this, true /* fromCache */), 'http-on-examine-merged-response'),
    ];
  }

  setExtraHTTPHeaders(browser, headers) {
    if (!headers)
      this._extraHTTPHeaders.delete(browser);
    else
      this._extraHTTPHeaders.set(browser, headers);
  }

  enableRequestInterception(browser) {
    this._browsersWithEnabledInterception.add(browser);
  }

  disableRequestInterception(browser) {
    this._browsersWithEnabledInterception.delete(browser);
    const interceptors = this._browserInterceptors.get(browser);
    if (!interceptors)
      return;
    this._browserInterceptors.delete(browser);
    for (const interceptor of interceptors.values())
      interceptor._resume();
  }

  _takeInterceptor(browser, requestId) {
    const interceptors = this._browserInterceptors.get(browser);
    if (!interceptors)
      throw new Error(`Request interception is not enabled`);
    const interceptor = interceptors.get(requestId);
    if (!interceptor)
      throw new Error(`Cannot find request "${requestId}"`);
    interceptors.delete(requestId);
    return interceptor;
  }

  resumeInterceptedRequest(browser, requestId, method, headers, postData) {
    this._takeInterceptor(browser, requestId)._resume(method, headers, postData);
  }

  getResponseBody(browser, requestId) {
    const responseStorage = this._browserResponseStorages.get(browser);
    if (!responseStorage)
      throw new Error('Responses are not tracked for the given browser');
    return responseStorage.getBase64EncodedResponse(requestId);
  }

  fulfillInterceptedRequest(browser, requestId, status, statusText, headers, base64body) {
    this._takeInterceptor(browser, requestId)._fulfill(status, statusText, headers, base64body);
  }

  abortInterceptedRequest(browser, requestId, errorCode) {
    this._takeInterceptor(browser, requestId)._abort(errorCode);
  }

  _requestAuthenticated(httpChannel) {
    this._pendingAuthentication.add(httpChannel.channelId + '');
  }

  _requestIdBeforeAuthentication(httpChannel) {
    const id = httpChannel.channelId + '';
    return this._postAuthChannelIdToRequestId.has(id) ? id : undefined;
  }

  _requestId(httpChannel) {
    const id = httpChannel.channelId + '';
    return this._postResumeChannelIdToRequestId.get(id) || this._postAuthChannelIdToRequestId.get(id) || id;
  }

  _onRedirect(oldChannel, newChannel, flags) {
    if (!(oldChannel instanceof Ci.nsIHttpChannel) || !(newChannel instanceof Ci.nsIHttpChannel))
      return;
    const oldHttpChannel = oldChannel.QueryInterface(Ci.nsIHttpChannel);
    const newHttpChannel = newChannel.QueryInterface(Ci.nsIHttpChannel);
    const browser = this._getBrowserForChannel(oldHttpChannel);
    if (!browser)
      return;
    const oldRequestId = this._requestId(oldHttpChannel);
    const newRequestId = this._requestId(newHttpChannel);
    if (this._resumedRequestIdToHeaders.has(oldRequestId)) {
      // When we call resetInterception on a request, we get a new "redirected" request for it.
      const { method, headers, postData } = this._resumedRequestIdToHeaders.get(oldRequestId);
      if (headers) {
        // Apply new request headers from interception resume.
        for (const header of requestHeaders(newChannel))
          newChannel.setRequestHeader(header.name, '', false /* merge */);
        for (const header of headers)
          newChannel.setRequestHeader(header.name, header.value, false /* merge */);
      }
      if (method)
        newChannel.requestMethod = method;
      if (postData && newChannel instanceof Ci.nsIUploadChannel) {
        const synthesized = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(Ci.nsIStringInputStream);
        synthesized.data = atob(postData);
        newChannel.setUploadStream(synthesized, 'application/octet-stream', -1);
      }
      // Use the old request id for the new "redirected" request for protocol consistency.
      this._resumedRequestIdToHeaders.delete(oldRequestId);
      this._postResumeChannelIdToRequestId.set(newRequestId, oldRequestId);
    } else if (!(flags & Ci.nsIChannelEventSink.REDIRECT_INTERNAL)) {
      // Regular (non-internal) redirect.
      this._redirectMap.set(newRequestId, oldRequestId);
    }
  }

  observeActivity(channel, activityType, activitySubtype, timestamp, extraSizeData, extraStringData) {
    if (activityType !== Ci.nsIHttpActivityObserver.ACTIVITY_TYPE_HTTP_TRANSACTION)
      return;
    if (!(channel instanceof Ci.nsIHttpChannel))
      return;
    const httpChannel = channel.QueryInterface(Ci.nsIHttpChannel);
    const browser = this._getBrowserForChannel(httpChannel);
    if (!browser)
      return;
    if (activitySubtype !== Ci.nsIHttpActivityObserver.ACTIVITY_SUBTYPE_TRANSACTION_CLOSE)
      return;
    if (this._isResumedChannel(httpChannel))
      return;
    if (this._requestIdBeforeAuthentication(httpChannel))
      return;
    this._sendOnRequestFinished(httpChannel);
  }

  _getBrowserForChannel(httpChannel) {
    let loadContext = null;
    try {
      if (httpChannel.notificationCallbacks)
        loadContext = httpChannel.notificationCallbacks.getInterface(Ci.nsILoadContext);
    } catch (e) {}
    try {
      if (!loadContext && httpChannel.loadGroup)
        loadContext = httpChannel.loadGroup.notificationCallbacks.getInterface(Ci.nsILoadContext);
    } catch (e) { }
    if (!loadContext || !this._browserSessionCount.has(loadContext.topFrameElement))
      return;
    return loadContext.topFrameElement;
  }

  _isResumedChannel(httpChannel) {
    return this._postResumeChannelIdToRequestId.has(httpChannel.channelId + '');
  }

  _onRequest(channel, topic) {
    if (!(channel instanceof Ci.nsIHttpChannel))
      return;
    const httpChannel = channel.QueryInterface(Ci.nsIHttpChannel);
    const browser = this._getBrowserForChannel(httpChannel);
    if (!browser)
      return;
    if (this._isResumedChannel(httpChannel)) {
      // Ignore onRequest for resumed requests, but listen to their response.
      new ResponseBodyListener(this, browser, httpChannel);
      return;
    }
    // Convert pending auth bit into auth mapping.
    const channelId = httpChannel.channelId + '';
    if (this._pendingAuthentication.has(channelId)) {
      this._postAuthChannelIdToRequestId.set(channelId, channelId + '-auth');
      this._redirectMap.set(channelId + '-auth', channelId);
      this._pendingAuthentication.delete(channelId);
      const bodyListener = this._bodyListeners.get(channelId);
      if (bodyListener)
        bodyListener.dispose();
    }
    const browserContext = TargetRegistry.instance().browserContextForBrowser(browser);
    if (browserContext)
      this._appendExtraHTTPHeaders(httpChannel, browserContext.options.extraHTTPHeaders);
    this._appendExtraHTTPHeaders(httpChannel, this._extraHTTPHeaders.get(browser));
    const requestId = this._requestId(httpChannel);
    const isRedirect = this._redirectMap.has(requestId);
    const interceptionEnabled = this._isInterceptionEnabledForBrowser(browser);
    if (!interceptionEnabled) {
      new NotificationCallbacks(this, browser, httpChannel, false);
      this._sendOnRequest(httpChannel, false);
      new ResponseBodyListener(this, browser, httpChannel);
    } else if (isRedirect) {
      // We pretend that redirect is interceptable in the protocol, although it's actually not
      // and therefore we do not instantiate the interceptor.
      // TODO: look into REDIRECT_MODE_MANUAL.
      const interceptors = this._ensureInterceptors(browser);
      interceptors.set(requestId, {
        _resume: () => {},
        _abort: () => {},
        _fulfill: () => {},
      });
      new NotificationCallbacks(this, browser, httpChannel, false);
      this._sendOnRequest(httpChannel, true);
      new ResponseBodyListener(this, browser, httpChannel);
    } else {
      const previousCallbacks = httpChannel.notificationCallbacks;
      if (previousCallbacks instanceof Ci.nsIInterfaceRequestor) {
        const interceptor = previousCallbacks.getInterface(Ci.nsINetworkInterceptController);
        // We assume that interceptor is a service worker if there is one.
        if (interceptor && interceptor.shouldPrepareForIntercept(httpChannel.URI, httpChannel)) {
          new NotificationCallbacks(this, browser, httpChannel, false);
          this._sendOnRequest(httpChannel, false);
          new ResponseBodyListener(this, browser, httpChannel);
        } else {
          // We'll issue onRequest once it's intercepted.
          new NotificationCallbacks(this, browser, httpChannel, true);
        }
      } else {
        // We'll issue onRequest once it's intercepted.
        new NotificationCallbacks(this, browser, httpChannel, true);
      }
    }
  }

  _isInterceptionEnabledForBrowser(browser) {
    if (this._browsersWithEnabledInterception.has(browser))
      return true;
    const browserContext = TargetRegistry.instance().browserContextForBrowser(browser);
    if (browserContext && browserContext.options.requestInterceptionEnabled)
      return true;
    if (browserContext && browserContext.options.onlineOverride === 'offline')
      return true;
    return false;
  }

  _ensureInterceptors(browser) {
    let interceptors = this._browserInterceptors.get(browser);
    if (!interceptors) {
      interceptors = new Map();
      this._browserInterceptors.set(browser, interceptors);
    }
    return interceptors;
  }

  _appendExtraHTTPHeaders(httpChannel, headers) {
    if (!headers)
      return;
    for (const header of headers)
      httpChannel.setRequestHeader(header.name, header.value, false /* merge */);
  }

  _onIntercepted(httpChannel, interceptor) {
    const browser = this._getBrowserForChannel(httpChannel);
    if (!browser) {
      interceptor._resume();
      return;
    }

    const browserContext = TargetRegistry.instance().browserContextForBrowser(browser);
    if (browserContext && browserContext.options.onlineOverride === 'offline') {
      interceptor._abort(Cr.NS_ERROR_OFFLINE);
      return;
    }

    const interceptionEnabled = this._isInterceptionEnabledForBrowser(browser);
    this._sendOnRequest(httpChannel, !!interceptionEnabled);
    if (interceptionEnabled)
      this._ensureInterceptors(browser).set(this._requestId(httpChannel), interceptor);
    else
      interceptor._resume();
  }

  _sendOnRequest(httpChannel, isIntercepted) {
    const browser = this._getBrowserForChannel(httpChannel);
    if (!browser)
      return;
    const causeType = httpChannel.loadInfo ? httpChannel.loadInfo.externalContentPolicyType : Ci.nsIContentPolicy.TYPE_OTHER;
    const requestId = this._requestId(httpChannel);
    const redirectedFrom = this._redirectMap.get(requestId);
    this._redirectMap.delete(requestId);
    this.emit('request', httpChannel, {
      url: httpChannel.URI.spec,
      isIntercepted,
      requestId,
      redirectedFrom,
      postData: readRequestPostData(httpChannel),
      headers: requestHeaders(httpChannel),
      method: httpChannel.requestMethod,
      navigationId: httpChannel.isMainDocumentChannel ? this._requestIdBeforeAuthentication(httpChannel) || this._requestId(httpChannel) : undefined,
      cause: causeTypeToString(causeType),
    });
  }

  _sendOnRequestFinished(httpChannel) {
    this.emit('requestfinished', httpChannel, {
      requestId: this._requestId(httpChannel),
    });
    this._cleanupChannelState(httpChannel);
  }

  _sendOnRequestFailed(httpChannel, error) {
    this.emit('requestfailed', httpChannel, {
      requestId: this._requestId(httpChannel),
      errorCode: helper.getNetworkErrorStatusText(error),
    });
    this._cleanupChannelState(httpChannel);
  }

  _cleanupChannelState(httpChannel) {
    const id = httpChannel.channelId + '';
    this._postResumeChannelIdToRequestId.delete(id);
    this._postAuthChannelIdToRequestId.delete(id);
  }

  _onResponse(fromCache, httpChannel, topic) {
    const browser = this._getBrowserForChannel(httpChannel);
    if (!browser)
      return;
    httpChannel.QueryInterface(Ci.nsIHttpChannelInternal);
    const headers = [];
    httpChannel.visitResponseHeaders({
      visitHeader: (name, value) => headers.push({name, value}),
    });

    let remoteIPAddress = undefined;
    let remotePort = undefined;
    try {
      remoteIPAddress = httpChannel.remoteAddress;
      remotePort = httpChannel.remotePort;
    } catch (e) {
      // remoteAddress is not defined for cached requests.
    }
    this.emit('response', httpChannel, {
      requestId: this._requestId(httpChannel),
      securityDetails: getSecurityDetails(httpChannel),
      fromCache,
      headers,
      remoteIPAddress,
      remotePort,
      status: httpChannel.responseStatus,
      statusText: httpChannel.responseStatusText,
    });
  }

  _onResponseFinished(browser, httpChannel, body) {
    const responseStorage = this._browserResponseStorages.get(browser);
    if (!responseStorage)
      return;
    responseStorage.addResponseBody(httpChannel, body);
    this._sendOnRequestFinished(httpChannel);
  }

  startTrackingBrowserNetwork(browser) {
    const value = this._browserSessionCount.get(browser) || 0;
    this._browserSessionCount.set(browser, value + 1);
    if (value === 0)
      this._browserResponseStorages.set(browser, new ResponseStorage(this, MAX_RESPONSE_STORAGE_SIZE, MAX_RESPONSE_STORAGE_SIZE / 10));
    return () => this.stopTrackingBrowserNetwork(browser);
  }

  stopTrackingBrowserNetwork(browser) {
    const value = this._browserSessionCount.get(browser);
    if (value) {
      this._browserSessionCount.set(browser, value - 1);
    } else {
      this._browserSessionCount.delete(browser);
      this._browserResponseStorages.delete(browser);
      this._browsersWithEnabledInterception.delete(browser);
      this._browserInterceptors.delete(browser);
    }
  }

  dispose() {
    this._activityDistributor.removeObserver(this);
    const registrar = Cm.QueryInterface(Ci.nsIComponentRegistrar);
    registrar.unregisterFactory(SINK_CLASS_ID, this._channelSinkFactory);
    Services.catMan.deleteCategoryEntry(SINK_CATEGORY_NAME, SINK_CONTRACT_ID, false);
    helper.removeListeners(this._eventListeners);
  }
}

const protocolVersionNames = {
  [Ci.nsITransportSecurityInfo.TLS_VERSION_1]: 'TLS 1',
  [Ci.nsITransportSecurityInfo.TLS_VERSION_1_1]: 'TLS 1.1',
  [Ci.nsITransportSecurityInfo.TLS_VERSION_1_2]: 'TLS 1.2',
  [Ci.nsITransportSecurityInfo.TLS_VERSION_1_3]: 'TLS 1.3',
};

function getSecurityDetails(httpChannel) {
  const securityInfo = httpChannel.securityInfo;
  if (!securityInfo)
    return null;
  securityInfo.QueryInterface(Ci.nsITransportSecurityInfo);
  if (!securityInfo.serverCert)
    return null;
  return {
    protocol: protocolVersionNames[securityInfo.protocolVersion] || '<unknown>',
    subjectName: securityInfo.serverCert.commonName,
    issuer: securityInfo.serverCert.issuerCommonName,
    // Convert to seconds.
    validFrom: securityInfo.serverCert.validity.notBefore / 1000 / 1000,
    validTo: securityInfo.serverCert.validity.notAfter / 1000 / 1000,
  };
}

function readRequestPostData(httpChannel) {
  if (!(httpChannel instanceof Ci.nsIUploadChannel))
    return undefined;
  const iStream = httpChannel.uploadStream;
  if (!iStream)
    return undefined;
  const isSeekableStream = iStream instanceof Ci.nsISeekableStream;

  let prevOffset;
  if (isSeekableStream) {
    prevOffset = iStream.tell();
    iStream.seek(Ci.nsISeekableStream.NS_SEEK_SET, 0);
  }

  // Read data from the stream.
  let text = undefined;
  try {
    text = NetUtil.readInputStreamToString(iStream, iStream.available());
    const converter = Cc['@mozilla.org/intl/scriptableunicodeconverter']
        .createInstance(Ci.nsIScriptableUnicodeConverter);
    converter.charset = 'UTF-8';
    text = converter.ConvertToUnicode(text);
  } catch (err) {
    text = undefined;
  }

  // Seek locks the file, so seek to the beginning only if necko hasn't
  // read it yet, since necko doesn't seek to 0 before reading (at lest
  // not till 459384 is fixed).
  if (isSeekableStream && prevOffset == 0)
    iStream.seek(Ci.nsISeekableStream.NS_SEEK_SET, 0);
  return text;
}

function requestHeaders(httpChannel) {
  const headers = [];
  httpChannel.visitRequestHeaders({
    visitHeader: (name, value) => headers.push({name, value}),
  });
  return headers;
}

function causeTypeToString(causeType) {
  for (let key in Ci.nsIContentPolicy) {
    if (Ci.nsIContentPolicy[key] === causeType)
      return key;
  }
  return 'TYPE_OTHER';
}

class ResponseStorage {
  constructor(networkObserver, maxTotalSize, maxResponseSize) {
    this._networkObserver = networkObserver;
    this._totalSize = 0;
    this._maxResponseSize = maxResponseSize;
    this._maxTotalSize = maxTotalSize;
    this._responses = new Map();
  }

  addResponseBody(httpChannel, body) {
    if (body.length > this._maxResponseSize) {
      this._responses.set(requestId, {
        evicted: true,
        body: '',
      });
      return;
    }
    let encodings = [];
    if ((httpChannel instanceof Ci.nsIEncodedChannel) && httpChannel.contentEncodings && !httpChannel.applyConversion) {
      const encodingHeader = httpChannel.getResponseHeader("Content-Encoding");
      encodings = encodingHeader.split(/\s*\t*,\s*\t*/);
    }
    this._responses.set(this._networkObserver._requestId(httpChannel), {body, encodings});
    this._totalSize += body.length;
    if (this._totalSize > this._maxTotalSize) {
      for (let [requestId, response] of this._responses) {
        this._totalSize -= response.body.length;
        response.body = '';
        response.evicted = true;
        if (this._totalSize < this._maxTotalSize)
          break;
      }
    }
  }

  getBase64EncodedResponse(requestId) {
    const response = this._responses.get(requestId);
    if (!response)
      throw new Error(`Request "${requestId}" is not found`);
    if (response.evicted)
      return {base64body: '', evicted: true};
    let result = response.body;
    if (response.encodings && response.encodings.length) {
      for (const encoding of response.encodings)
        result = CommonUtils.convertString(result, encoding, 'uncompressed');
    }
    return {base64body: btoa(result)};
  }
}

class ResponseBodyListener {
  constructor(networkObserver, browser, httpChannel) {
    this._networkObserver = networkObserver;
    this._browser = browser;
    this._httpChannel = httpChannel;
    this._chunks = [];
    this.QueryInterface = ChromeUtils.generateQI([Ci.nsIStreamListener]);
    httpChannel.QueryInterface(Ci.nsITraceableChannel);
    this.originalListener = httpChannel.setNewListener(this);
    this._disposed = false;
    this._networkObserver._bodyListeners.set(this._httpChannel.channelId + '', this);
  }

  onDataAvailable(aRequest, aInputStream, aOffset, aCount) {
    if (this._disposed) {
      this.originalListener.onDataAvailable(aRequest, aInputStream, aOffset, aCount);
      return;
    }

    const iStream = new BinaryInputStream(aInputStream);
    const sStream = new StorageStream(8192, aCount, null);
    const oStream = new BinaryOutputStream(sStream.getOutputStream(0));

    // Copy received data as they come.
    const data = iStream.readBytes(aCount);
    this._chunks.push(data);

    oStream.writeBytes(data, aCount);
    this.originalListener.onDataAvailable(aRequest, sStream.newInputStream(0), aOffset, aCount);
  }

  onStartRequest(aRequest) {
    this.originalListener.onStartRequest(aRequest);
  }

  onStopRequest(aRequest, aStatusCode) {
    this.originalListener.onStopRequest(aRequest, aStatusCode);
    if (this._disposed)
      return;

    const body = this._chunks.join('');
    delete this._chunks;
    this._networkObserver._onResponseFinished(this._browser, this._httpChannel, body);
    this.dispose();
  }

  dispose() {
    this._disposed = true;
    this._networkObserver._bodyListeners.delete(this._httpChannel.channelId + '');
  }
}

class NotificationCallbacks {
  constructor(networkObserver, browser, httpChannel, shouldIntercept) {
    this._networkObserver = networkObserver;
    this._browser = browser;
    this._shouldIntercept = shouldIntercept;
    this._httpChannel = httpChannel;
    this._previousCallbacks = httpChannel.notificationCallbacks;
    httpChannel.notificationCallbacks = this;

    const qis = [
      Ci.nsIAuthPrompt2,
      Ci.nsIAuthPromptProvider,
      Ci.nsIInterfaceRequestor,
    ];
    if (shouldIntercept)
      qis.push(Ci.nsINetworkInterceptController);
    this.QueryInterface = ChromeUtils.generateQI(qis);
  }

  getInterface(iid) {
    if (iid.equals(Ci.nsIAuthPrompt2) || iid.equals(Ci.nsIAuthPromptProvider))
      return this;
    if (this._shouldIntercept && iid.equals(Ci.nsINetworkInterceptController))
      return this;
    if (iid.equals(Ci.nsIAuthPrompt))  // Block nsIAuthPrompt - we want nsIAuthPrompt2 to be used instead.
      throw Cr.NS_ERROR_NO_INTERFACE;
    if (this._previousCallbacks)
      return this._previousCallbacks.getInterface(iid);
    throw Cr.NS_ERROR_NO_INTERFACE;
  }

  _forward(iid, method, args) {
    if (!this._previousCallbacks)
      return;
    try {
      const impl = this._previousCallbacks.getInterface(iid);
      impl[method].apply(impl, args);
    } catch (e) {
      if (e.result != Cr.NS_ERROR_NO_INTERFACE)
        throw e;
    }
  }

  // nsIAuthPromptProvider
  getAuthPrompt(aPromptReason, iid) {
    return this;
  }

  // nsIAuthPrompt2
  asyncPromptAuth(aChannel, aCallback, aContext, level, authInfo) {
    let canceled = false;
    Promise.resolve().then(() => {
      if (canceled)
        return;
      const hasAuth = this.promptAuth(aChannel, level, authInfo);
      if (hasAuth)
        aCallback.onAuthAvailable(aContext, authInfo);
      else
        aCallback.onAuthCancelled(aContext, true);
    });
    return {
      QueryInterface: ChromeUtils.generateQI([Ci.nsICancelable]),
      cancel: () => {
        aCallback.onAuthCancelled(aContext, false);
        canceled = true;
      }
    };
  }

  // nsIAuthPrompt2
  promptAuth(aChannel, level, authInfo) {
    if (authInfo.flags & Ci.nsIAuthInformation.PREVIOUS_FAILED)
      return false;
    const browserContext = TargetRegistry.instance().browserContextForBrowser(this._browser);
    const credentials = browserContext ? browserContext.options.httpCredentials : undefined;
    if (!credentials)
      return false;
    authInfo.username = credentials.username;
    authInfo.password = credentials.password;
    this._networkObserver._requestAuthenticated(this._httpChannel);
    return true;
  }

  // nsINetworkInterceptController
  shouldPrepareForIntercept(aURI, channel) {
    if (!(channel instanceof Ci.nsIHttpChannel))
      return false;
    const httpChannel = channel.QueryInterface(Ci.nsIHttpChannel);
    return httpChannel.channelId === this._httpChannel.channelId;
  }

  // nsINetworkInterceptController
  channelIntercepted(intercepted) {
    this._intercepted = intercepted.QueryInterface(Ci.nsIInterceptedChannel);
    const httpChannel = this._intercepted.channel.QueryInterface(Ci.nsIHttpChannel);
    this._networkObserver._onIntercepted(httpChannel, this);
  }

  _resume(method, headers, postData) {
    this._networkObserver._resumedRequestIdToHeaders.set(this._networkObserver._requestId(this._httpChannel), { method, headers, postData });
    this._intercepted.resetInterception();
  }

  _fulfill(status, statusText, headers, base64body) {
    this._intercepted.synthesizeStatus(status, statusText);
    for (const header of headers)
      this._intercepted.synthesizeHeader(header.name, header.value);
    const synthesized = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(Ci.nsIStringInputStream);
    const body = base64body ? atob(base64body) : '';
    synthesized.data = body;
    this._intercepted.startSynthesizedResponse(synthesized, null, null, '', false);
    this._intercepted.finishSynthesizedResponse();
    this._networkObserver.emit('response', this._httpChannel, {
      requestId: this._networkObserver._requestId(this._httpChannel),
      securityDetails: null,
      fromCache: false,
      headers,
      status,
      statusText,
    });
    this._networkObserver._onResponseFinished(this._browser, this._httpChannel, body);
  }

  _abort(errorCode) {
    const error = errorMap[errorCode] || Cr.NS_ERROR_FAILURE;
    this._intercepted.cancelInterception(error);
    this._networkObserver._sendOnRequestFailed(this._httpChannel, error);
  }
}

const errorMap = {
  'aborted': Cr.NS_ERROR_ABORT,
  'accessdenied': Cr.NS_ERROR_PORT_ACCESS_NOT_ALLOWED,
  'addressunreachable': Cr.NS_ERROR_UNKNOWN_HOST,
  'blockedbyclient': Cr.NS_ERROR_FAILURE,
  'blockedbyresponse': Cr.NS_ERROR_FAILURE,
  'connectionaborted': Cr.NS_ERROR_NET_INTERRUPT,
  'connectionclosed': Cr.NS_ERROR_FAILURE,
  'connectionfailed': Cr.NS_ERROR_FAILURE,
  'connectionrefused': Cr.NS_ERROR_CONNECTION_REFUSED,
  'connectionreset': Cr.NS_ERROR_NET_RESET,
  'internetdisconnected': Cr.NS_ERROR_OFFLINE,
  'namenotresolved': Cr.NS_ERROR_UNKNOWN_HOST,
  'timedout': Cr.NS_ERROR_NET_TIMEOUT,
  'failed': Cr.NS_ERROR_FAILURE,
};

var EXPORTED_SYMBOLS = ['NetworkObserver'];
this.NetworkObserver = NetworkObserver;
