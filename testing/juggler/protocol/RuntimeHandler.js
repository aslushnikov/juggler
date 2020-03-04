"use strict";

const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const helper = new Helper();

class RuntimeHandler {
  constructor(chromeSession, sessionId, contentChannel) {
    this._chromeSession = chromeSession;
    this._contentSession = contentChannel.connect(sessionId + 'runtime');
    this._eventListeners = [
      contentChannel.register(sessionId + 'runtime', {
        protocol: (eventName, params) => this._chromeSession.emitEvent(eventName, params),
      }),
    ];
  }

  async evaluate(options) {
    return await this._contentSession.send('evaluate', options);
  }

  async callFunction(options) {
    return await this._contentSession.send('callFunction', options);
  }

  async getObjectProperties(options) {
    return await this._contentSession.send('getObjectProperties', options);
  }

  async disposeObject(options) {
    return await this._contentSession.send('disposeObject', options);
  }

  dispose() {
    helper.removeListeners(this._eventListeners);
  }
}

var EXPORTED_SYMBOLS = ['RuntimeHandler'];
this.RuntimeHandler = RuntimeHandler;
