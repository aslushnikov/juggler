"use strict";
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');

const helper = new Helper();

class NetworkMonitor {
  constructor(rootDocShell, frameTree) {
    this._frameTree = frameTree;
    this._requestDetails = new Map();

    this._eventListeners = [
      helper.addObserver(this._onRequest.bind(this), 'http-on-opening-request'),
    ];
  }

  _onRequest(channel) {
    if (!(channel instanceof Ci.nsIHttpChannel))
      return;
    const httpChannel = channel.QueryInterface(Ci.nsIHttpChannel);
    const loadContext = getLoadContext(httpChannel);
    if (!loadContext)
      return;
    const window = loadContext.associatedWindow;
    const frame = this._frameTree.frameForDocShell(window.docShell);
    if (!frame)
      return;
    this._requestDetails.set(httpChannel.channelId, {
      frameId: frame.id(),
    });
  }

  requestDetails(channelId) {
    return this._requestDetails.get(channelId) || null;
  }

  dispose() {
    this._requestDetails.clear();
    helper.removeListeners(this._eventListeners);
  }
}

function getLoadContext(httpChannel) {
  let loadContext = null;
  try {
    if (httpChannel.notificationCallbacks)
      loadContext = httpChannel.notificationCallbacks.getInterface(Ci.nsILoadContext);
  } catch (e) {}
  try {
    if (!loadContext && httpChannel.loadGroup)
      loadContext = httpChannel.loadGroup.notificationCallbacks.getInterface(Ci.nsILoadContext);
  } catch (e) { }
  return loadContext;
}


var EXPORTED_SYMBOLS = ['NetworkMonitor'];
this.NetworkMonitor = NetworkMonitor;

